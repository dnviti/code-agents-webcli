import { randomUUID } from 'node:crypto';
import { EnvironmentEngine } from './engine.js';
import { WrappedProcessControl } from './types.js';

/** `/tmp` is private to one environment; UUIDs keep concurrent runs separate. */
const CONTROL_ROOT = '/tmp/code-agents-webcli-runtime';
const MEMBER_TOKEN_ENV = 'CODE_AGENTS_WEBCLI_RUNTIME_TOKEN';

/**
 * Entry point run by docker/podman/kubectl exec.
 *
 * A TTY exec normally makes this process PID=PGID=SID and gives it the
 * controlling terminal. In that case it becomes the anchor in place: using
 * `setsid -c` would fail because this session already owns the PTY, while a
 * plain second session would silently disable shell job control. Pipe execs on
 * the supported engines have the same isolated topology. The fallback is only
 * for an engine that did not isolate its exec process; it creates a session
 * without trying to steal a controlling terminal.
 */
export const TRACKED_PROCESS_WRAPPER = String.raw`
tty=$1
control_file=$2
done_file=$3
token=$4
anchor_wrapper=$5
shift 5

proc_fields() {
  stat_line=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat_tail=${'$'}{stat_line##*) }
  set -- $stat_tail
  [ "$#" -ge 20 ] || return 1
  process_state=$1
  process_group=${'$'}{3}
  process_session=${'$'}{4}
  process_start=${'$'}{20}
}

control_dir=${'$'}{control_file%/*}
umask 077
mkdir -p "$control_dir" || exit 70
rm -f "$control_file" "$done_file"

self=$$
proc_fields "$self" || exit 71
if [ "$process_state" != "Z" ] \
  && [ "$process_group" = "$self" ] \
  && [ "$process_session" = "$self" ]; then
  exec sh -c "$anchor_wrapper" sh \
    "$control_file" "$done_file" "$token" "$@"
fi

command -v setsid >/dev/null 2>&1 || {
  echo 'tracked runtimes require setsid inside the environment' >&2
  exit 71
}

# Keep this exec client attached if setsid has to fork. The inner session
# leader, not this compatibility waiter, is the immutable signalling authority.
setsid sh -c "$anchor_wrapper" sh \
  "$control_file" "$done_file" "$token" "$@" <&0 >&1 2>&2 &
launcher=$!
status=0
wait "$launcher" || status=$?
exit "$status"
`;

/**
 * Immutable remote session leader.
 *
 * It forks rather than execs the runtime and stays PID=PGID=SID until every
 * non-zombie member has gone. SID scanning covers an interactive shell's job
 * control groups. The inherited UUID environment token also follows ordinary
 * `setsid`/double-fork descendants, so daemonising does not escape tracking
 * merely by opening another session.
 */
export const TRACKED_PROCESS_GROUP_WRAPPER = String.raw`
control_file=$1
done_file=$2
token=$3
shift 3

proc_fields() {
  stat_line=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat_tail=${'$'}{stat_line##*) }
  set -- $stat_tail
  [ "$#" -ge 20 ] || return 1
  process_state=$1
  process_group=${'$'}{3}
  process_session=${'$'}{4}
  process_start=${'$'}{20}
}

same_process() {
  proc_fields "$1" || return 1
  [ "$process_state" != "Z" ] && [ "$process_start" = "$2" ]
}

has_token() {
  grep -F -z -x -q "${MEMBER_TOKEN_ENV}=$token" \
    "/proc/$1/environ" 2>/dev/null
}

tracked_alive() {
  for stat_file in /proc/[0-9]*/stat; do
    pid=${'$'}{stat_file#/proc/}
    pid=${'$'}{pid%/stat}
    [ "$pid" = "$leader" ] && continue
    proc_fields "$pid" || continue
    [ "$process_state" != "Z" ] || continue
    if [ "$process_session" = "$leader" ] || has_token "$pid"; then
      return 0
    fi
  done
  return 1
}

leader=$$
proc_fields "$leader" || exit 72
[ "$process_state" != "Z" ] \
  && [ "$process_group" = "$leader" ] \
  && [ "$process_session" = "$leader" ] || {
  echo 'could not establish an isolated runtime session' >&2
  exit 72
}
leader_start=$process_start

case "$token" in
  ''|*[!A-Fa-f0-9-]*) exit 72 ;;
esac
${MEMBER_TOKEN_ENV}=$token
export ${MEMBER_TOKEN_ENV}

# Ctrl-C and terminal hangup belong to the runtime, not its identity anchor.
# The stop controller signals members directly and leaves the anchor alive
# until their absence has been proved.
trap ':' TERM INT HUP

tmp_file="$control_file.$leader"
printf '%s %s %s %s %s\n' \
  "$leader" "$leader_start" "$process_group" "$process_session" "$token" \
  > "$tmp_file" || exit 72
mv "$tmp_file" "$control_file" || exit 72

"$@" <&0 >&1 2>&2 &
runtime=$!
runtime_start=''
remaining=3
while [ -z "$runtime_start" ] && [ "$remaining" -gt 0 ]; do
  if proc_fields "$runtime"; then runtime_start=$process_start; break; fi
  sleep 1
  remaining=$((remaining - 1))
done

status=0
if [ -n "$runtime_start" ]; then
  while same_process "$runtime" "$runtime_start"; do
    wait "$runtime" || status=$?
  done
else
  wait "$runtime" || status=$?
fi

# A CLI can leave shell jobs or a detached helper behind. Keep the exec and its
# admission owner alive until SID/token scans see no non-zombie member.
quiet_scans=0
while [ "$quiet_scans" -lt 2 ]; do
  if tracked_alive; then
    quiet_scans=0
  else
    quiet_scans=$((quiet_scans + 1))
  fi
  [ "$quiet_scans" -ge 2 ] || sleep 1
done

: > "$done_file"
exit "$status"
`;

/**
 * Identity-bound TERM -> KILL controller run through a second engine exec.
 *
 * No numeric PID or process group is signalled after the exact session leader
 * disappears. While it is alive, repeated `/proc` scans cover new descendants,
 * job-control groups and ordinary detached children. `.done` is a durable,
 * idempotent tombstone: it is deliberately never consumed, because the local
 * control-plane timeout cannot cancel an exec that may succeed later.
 */
export const STOP_TRACKED_PROCESS = String.raw`
control_file=$1
done_file=$2

proc_fields() {
  stat_line=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat_tail=${'$'}{stat_line##*) }
  set -- $stat_tail
  [ "$#" -ge 20 ] || return 1
  process_state=$1
  process_group_now=${'$'}{3}
  process_session_now=${'$'}{4}
  process_start_now=${'$'}{20}
}

same_process() {
  [ -n "$1" ] && [ -n "$2" ] || return 1
  proc_fields "$1" || return 1
  [ "$process_state" != "Z" ] && [ "$process_start_now" = "$2" ]
}

read_identity() {
  [ -r "$control_file" ] || return 1
  IFS=' ' read -r leader leader_start process_group process_session token \
    < "$control_file" || return 1
  case "$leader:$leader_start:$process_group:$process_session" in
    ''|*[!0-9:]*) return 1 ;;
  esac
  case "$token" in
    ''|*[!A-Fa-f0-9-]*) return 1 ;;
  esac
  [ "$process_group" = "$leader" ] && [ "$process_session" = "$leader" ]
}

leader_owns_session() {
  same_process "$leader" "$leader_start" || return 1
  [ "$process_group_now" = "$process_group" ] \
    && [ "$process_session_now" = "$process_session" ]
}

has_token() {
  grep -F -z -x -q "${MEMBER_TOKEN_ENV}=$token" \
    "/proc/$1/environ" 2>/dev/null
}

is_tracked_member() {
  pid=$1
  [ "$pid" = "$leader" ] && return 1
  proc_fields "$pid" || return 1
  [ "$process_state" != "Z" ] || return 1
  member_start=$process_start_now
  if [ "$process_session_now" = "$process_session" ] || has_token "$pid"; then
    return 0
  fi
  return 1
}

tracked_alive() {
  for stat_file in /proc/[0-9]*/stat; do
    pid=${'$'}{stat_file#/proc/}
    pid=${'$'}{pid%/stat}
    is_tracked_member "$pid" && return 0
  done
  return 1
}

tracked_quiet() {
  tracked_alive && return 1
  # The /proc/[0-9]* glob expands to one snapshot. A member can fork after expansion
  # and exit before its entry is visited, so absence is authoritative only
  # across two scans separated by a scheduler interval.
  sleep 1
  ! tracked_alive
}

signal_tracked() {
  requested_signal=$1
  for stat_file in /proc/[0-9]*/stat; do
    pid=${'$'}{stat_file#/proc/}
    pid=${'$'}{pid%/stat}
    is_tracked_member "$pid" || continue
    recorded_member_start=$member_start
    # Recheck immediately before signalling. A replacement PID cannot retain
    # this session/token authority, and is never deliberately targeted.
    is_tracked_member "$pid" || continue
    [ "$member_start" = "$recorded_member_start" ] || continue
    kill -"$requested_signal" "$pid" 2>/dev/null || true
  done
}

mark_settled() {
  : > "$done_file" || return 1
}

settled() {
  same_process "$leader" "$leader_start" && return 1
  if [ -f "$done_file" ]; then
    ! tracked_alive
    return
  fi
  tracked_quiet || return 1
  mark_settled
}

wait_members() {
  remaining=$1
  requested_signal=$2
  while [ "$remaining" -gt 0 ]; do
    tracked_alive || return 0
    leader_owns_session || return 1
    signal_tracked "$requested_signal"
    sleep 1
    remaining=$((remaining - 1))
  done
  ! tracked_alive
}

wait_settled() {
  remaining=$1
  while [ "$remaining" -gt 0 ]; do
    settled && return 0
    sleep 1
    remaining=$((remaining - 1))
  done
  settled
}

# Kubernetes admission and image startup can take materially longer than a
# local docker exec. A short command may finish before this controller arrives;
# its durable marker is sufficient proof even if no identity remains to read.
remaining=10
while ! read_identity; do
  [ -f "$done_file" ] && exit 0
  [ "$remaining" -gt 0 ] || exit 73
  sleep 1
  remaining=$((remaining - 1))
done

settled && exit 0
leader_owns_session || exit 75

signal_tracked TERM
if wait_members 5 TERM; then
  wait_settled 3 && exit 0
fi

# Loss of the immutable anchor closes signalling authority. Retain admission
# rather than aiming KILL at any numeric PID/group that might now be unrelated.
leader_owns_session || exit 75
signal_tracked KILL
wait_members 5 KILL || {
  echo 'tracked runtime descendants still exist after SIGKILL' >&2
  exit 74
}

wait_settled 3 && exit 0

# No descendant remains, so the anchor itself is the only possible obstruction.
# Validate it one last time, kill exactly that process, then leave a durable
# completion proof after its identity disappears.
if leader_owns_session && tracked_quiet; then
  kill -KILL "$leader" 2>/dev/null || true
  wait_settled 2 && exit 0
fi

echo 'tracked runtime still exists after SIGKILL' >&2
exit 74
`;

const CONTROL_TIMEOUT_MS = 45_000;

export class ContainerProcessControl implements WrappedProcessControl {
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly engine: EnvironmentEngine,
    private readonly containerName: string,
    private readonly containerIdentity: string | undefined,
    private readonly controlFile: string,
    private readonly doneFile: string,
  ) {}

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;

    const attempt = this.stopOnce();
    this.stopping = attempt;
    try {
      await attempt;
    } catch (error) {
      // A later explicit stop may retry after a transient engine/control-plane
      // failure. Durable remote tombstones make a late first success observable.
      if (this.stopping === attempt) this.stopping = null;
      throw error;
    }
  }

  private async stopOnce(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(
          `Could not verify that the runtime in ${this.containerName} stopped`,
        ));
      }, CONTROL_TIMEOUT_MS);
      timeout.unref?.();
    });

    try {
      await Promise.race([
        this.engine.exec(
          {
            name: this.containerName,
            ...(this.containerIdentity ? { identity: this.containerIdentity } : {}),
          },
          'sh',
          ['-c', STOP_TRACKED_PROCESS, 'sh', this.controlFile, this.doneFile],
        ),
        timedOut,
      ]);
      // The durable files must survive a local timeout because the remote
      // controller may still complete afterwards. Once this caller has
      // actually observed success, however, this handle itself is the durable
      // proof and the per-run files can be removed. Cleanup is deliberately
      // best effort and identity-bound; its failure cannot undo verified exit.
      void this.engine.exec(
        {
          name: this.containerName,
          ...(this.containerIdentity ? { identity: this.containerIdentity } : {}),
        },
        'sh',
        ['-c', 'rm -f -- "$1" "$2"', 'sh', this.controlFile, this.doneFile],
      ).catch(() => {});
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not verify that the runtime in ${this.containerName} stopped: ${detail}`,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export function trackContainerProcess(
  engine: EnvironmentEngine,
  containerName: string,
  containerIdentity: string | undefined,
  command: string,
  args: string[],
  tty: boolean,
): { command: string; args: string[]; processControl: WrappedProcessControl } {
  const token = randomUUID();
  const controlFile = `${CONTROL_ROOT}/${token}.pid`;
  const doneFile = `${CONTROL_ROOT}/${token}.done`;

  return {
    command: 'sh',
    args: [
      '-c', TRACKED_PROCESS_WRAPPER, 'sh', tty ? '1' : '0', controlFile, doneFile,
      token, TRACKED_PROCESS_GROUP_WRAPPER,
      command, ...args,
    ],
    processControl: new ContainerProcessControl(
      engine,
      containerName,
      containerIdentity,
      controlFile,
      doneFile,
    ),
  };
}
