const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The parser between `gh` and the GitHub panel.
//
// Every fixture below is real `gh` output, captured from this repository with
// the exact `--json` field list the routes ask for — a hand-invented event
// shape would only ever prove that the parser agrees with the parser. The two
// exceptions are `subIssues` and `parent` with something in them, which this
// repository has never had: those are `gh`'s own GraphQL selection, read out of
// the binary (`subIssues(first:100){nodes{id,number,title,url,state,repository
// {nameWithOwner}},totalCount}`), which is the contract itself.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

before(function () {
  this.timeout(60000);

  bundle = path.join(os.tmpdir(), `github-items-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(path.join(ROOT, 'src/shared/github-items'))};`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'github-items.ts',
    },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

/** One row of `gh issue list --json ...ISSUE_LIST_FIELDS`, verbatim. */
const ISSUE_ROW = {
  assignees: [{ id: 'MDQ6VXNlcjg2NDk0ODg=', login: 'dnviti', name: 'Daniele Viti', databaseId: 8649488 }],
  author: { id: 'MDQ6VXNlcjg2NDk0ODg=', is_bot: false, login: 'dnviti', name: 'Daniele Viti' },
  blockedBy: { nodes: [], totalCount: 0 },
  closedByPullRequestsReferences: [
    {
      id: 'PR_kwDOR1QKUM74GKWG',
      number: 151,
      repository: { id: 'R_kgDOR1QKUA', name: 'code-agents-webcli', owner: { id: 'MDQ6VXNlcjg2NDk0ODg=', login: 'dnviti' } },
      url: 'https://github.com/dnviti/code-agents-webcli/pull/151',
    },
  ],
  issueType: null,
  labels: [{ id: 'LA_kwDOR1QKUM8AAAACdbHF5Q', name: 'enhancement', description: 'New feature or request', color: 'a2eeef' }],
  milestone: { number: 1, title: '6.0.0', description: 'Next major release', dueOn: null },
  number: 134,
  parent: null,
  state: 'OPEN',
  subIssuesSummary: { completed: 0, percentCompleted: 0, total: 0 },
  title: 'Approval mode is not applied consistently',
  updatedAt: '2026-07-30T19:36:42Z',
  url: 'https://github.com/dnviti/code-agents-webcli/issues/134',
};

/** One row of `gh pr list --json ...PR_LIST_FIELDS`, verbatim. */
const PR_ROW = {
  assignees: [],
  author: { id: 'MDQ6VXNlcjg2NDk0ODg=', is_bot: false, login: 'dnviti', name: 'Daniele Viti' },
  baseRefName: 'main',
  closingIssuesReferences: [
    {
      id: 'I_kwDOR1QKUM8AAAABKjLT7w',
      number: 113,
      repository: { id: 'R_kgDOR1QKUA', name: 'code-agents-webcli', owner: { id: 'MDQ6VXNlcjg2NDk0ODg=', login: 'dnviti' } },
      url: 'https://github.com/dnviti/code-agents-webcli/issues/113',
    },
  ],
  headRefName: 'chore/version-bump-6.0.0',
  isDraft: false,
  labels: [],
  milestone: null,
  number: 59,
  reviewDecision: '',
  state: 'OPEN',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      completedAt: '2026-07-30T19:17:54Z',
      conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/dnviti/code-agents-webcli/actions/runs/1/job/1',
      name: 'Verify Node 22',
      startedAt: '2026-07-30T19:16:39Z',
      status: 'COMPLETED',
      workflowName: 'CI',
    },
    {
      __typename: 'CheckRun',
      completedAt: '',
      conclusion: '',
      detailsUrl: 'https://github.com/dnviti/code-agents-webcli/actions/runs/1/job/2',
      name: 'Verify Node 24',
      startedAt: '2026-07-30T19:16:33Z',
      status: 'IN_PROGRESS',
      workflowName: 'CI',
    },
  ],
  title: 'chore: 6.0.0 release branch',
  updatedAt: '2026-07-30T19:36:42Z',
  url: 'https://github.com/dnviti/code-agents-webcli/pull/59',
};

/** `gh api graphql` for issue #163's cross-references, verbatim. */
const TIMELINE = {
  data: {
    repository: {
      issueOrPullRequest: {
        __typename: 'Issue',
        timelineItems: {
          nodes: [
            {
              willCloseTarget: false,
              source: {
                __typename: 'PullRequest',
                number: 164,
                title: 'chore: 5.3.4 release branch',
                url: 'https://github.com/dnviti/code-agents-webcli/pull/164',
                state: 'MERGED',
                isDraft: false,
                repository: { nameWithOwner: 'dnviti/code-agents-webcli' },
              },
            },
            {
              willCloseTarget: true,
              source: {
                __typename: 'PullRequest',
                number: 165,
                title: 'fix: every window and device shows the same tabs',
                url: 'https://github.com/dnviti/code-agents-webcli/pull/165',
                state: 'MERGED',
                isDraft: false,
                repository: { nameWithOwner: 'dnviti/code-agents-webcli' },
              },
            },
          ],
        },
      },
    },
  },
};

describe('what the GitHub panel is told about an issue', function () {
  it('names who it is assigned to', function () {
    const issue = mod.normalizeIssue(ISSUE_ROW);
    assert.deepStrictEqual(issue.assignees, [{ login: 'dnviti', name: 'Daniele Viti' }]);
    assert.strictEqual(issue.author.login, 'dnviti');
  });

  it('names the pull request that would close it', function () {
    const issue = mod.normalizeIssue(ISSUE_ROW);
    // `closedByPullRequestsReferences` says nothing about what it points at, so
    // the kind has to come off the URL. Getting it wrong opens `issue 151`.
    assert.deepStrictEqual(issue.references, [
      {
        kind: 'pr',
        number: 151,
        url: 'https://github.com/dnviti/code-agents-webcli/pull/151',
        repo: 'dnviti/code-agents-webcli',
        relation: 'closed-by',
      },
    ]);
  });

  it('keeps the milestone as the one thing anyone reads off it', function () {
    assert.strictEqual(mod.normalizeIssue(ISSUE_ROW).milestone, '6.0.0');
  });

  it('leaves out everything that is empty', function () {
    const issue = mod.normalizeIssue(ISSUE_ROW);
    // An issue with no sub-issues must not carry a "0 done" that would draw an
    // empty progress bar, and no empty arrays to pay for on the wire.
    assert.ok(!('childrenTotal' in issue), JSON.stringify(issue));
    assert.ok(!('childrenDone' in issue));
    assert.ok(!('parent' in issue));
    assert.ok(!('blockedBy' in issue));
    assert.ok(!('children' in issue));
  });

  it('counts sub-issues, and says which they are', function () {
    const issue = mod.normalizeIssue({
      ...ISSUE_ROW,
      subIssuesSummary: { completed: 1, percentCompleted: 50, total: 2 },
      subIssues: {
        nodes: [
          { id: 'a', number: 168, title: 'Projects', url: 'https://github.com/dnviti/code-agents-webcli/issues/168', state: 'CLOSED', repository: { nameWithOwner: 'dnviti/code-agents-webcli' } },
          { id: 'b', number: 169, title: 'Containers', url: 'https://github.com/dnviti/code-agents-webcli/issues/169', state: 'OPEN', repository: { nameWithOwner: 'dnviti/code-agents-webcli' } },
        ],
        totalCount: 2,
      },
    });
    assert.strictEqual(issue.childrenTotal, 2);
    assert.strictEqual(issue.childrenDone, 1);
    assert.deepStrictEqual(issue.children.map((one) => one.number), [168, 169]);
    assert.strictEqual(issue.children[0].relation, 'child');
    assert.strictEqual(issue.children[0].kind, 'issue');
  });

  it('counts sub-issues from the children themselves when there is no summary', function () {
    // The summary is a separate field, and a `gh` that stops returning it must
    // cost the percentage and not the whole section.
    const issue = mod.normalizeIssue({
      ...ISSUE_ROW,
      subIssuesSummary: null,
      subIssues: {
        nodes: [
          { number: 168, url: 'https://github.com/o/r/issues/168', state: 'CLOSED' },
          { number: 169, url: 'https://github.com/o/r/issues/169', state: 'OPEN' },
        ],
        totalCount: 2,
      },
    });
    assert.strictEqual(issue.childrenTotal, 2);
    assert.strictEqual(issue.childrenDone, 1);
  });

  it('names the issue it is part of', function () {
    const issue = mod.normalizeIssue({
      ...ISSUE_ROW,
      parent: {
        id: 'I_1', number: 100, title: 'The epic', state: 'OPEN',
        url: 'https://github.com/dnviti/code-agents-webcli/issues/100',
        repository: { nameWithOwner: 'dnviti/code-agents-webcli' },
      },
    });
    assert.strictEqual(issue.parent.number, 100);
    assert.strictEqual(issue.parent.relation, 'parent');
    assert.strictEqual(issue.parent.title, 'The epic');
  });

  it('says what is blocking it', function () {
    const issue = mod.normalizeIssue({
      ...ISSUE_ROW,
      blockedBy: {
        nodes: [{ number: 12, title: 'First', state: 'OPEN', url: 'https://github.com/o/r/issues/12' }],
        totalCount: 1,
      },
    });
    assert.deepStrictEqual(issue.blockedBy.map((one) => one.number), [12]);
    assert.strictEqual(issue.blockedBy[0].relation, 'blocked-by');
  });
});

describe('what the GitHub panel is told about a pull request', function () {
  it('names the issues it closes', function () {
    const pull = mod.normalizePull(PR_ROW);
    assert.deepStrictEqual(pull.references.map((one) => [one.kind, one.number, one.relation]), [
      ['issue', 113, 'closes'],
    ]);
  });

  it('reduces every CI job to one line', function () {
    const pull = mod.normalizePull(PR_ROW);
    assert.deepStrictEqual(pull.checks, {
      total: 2, passed: 1, failed: 0, pending: 1, state: 'pending',
    });
  });

  it('calls a run that failed failing', function () {
    const pull = mod.normalizePull({
      ...PR_ROW,
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'a' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', name: 'b' },
        // A commit status, which reports neither `status` nor `conclusion`.
        { __typename: 'StatusContext', state: 'SUCCESS', context: 'ci/other' },
      ],
    });
    assert.deepStrictEqual(pull.checks, { total: 3, passed: 2, failed: 1, pending: 0, state: 'failing' });
  });

  it('says nothing about CI on a pull request nothing has run on', function () {
    const pull = mod.normalizePull({ ...PR_ROW, statusCheckRollup: [] });
    assert.ok(!('checks' in pull));
  });

  it('treats an empty review decision as no decision', function () {
    assert.ok(!('reviewDecision' in mod.normalizePull(PR_ROW)));
    assert.strictEqual(mod.normalizePull({ ...PR_ROW, reviewDecision: 'APPROVED' }).reviewDecision, 'APPROVED');
    assert.strictEqual(mod.reviewDecisionLabel('CHANGES_REQUESTED'), 'Changes requested');
    assert.strictEqual(mod.reviewDecisionLabel(''), undefined);
  });

  it('reads a requested reviewer through the wrapper gh puts it in', function () {
    const pull = mod.normalizePull({
      ...PR_ROW,
      // `gh pr view --json reviewRequests` exports the reviewer itself; the
      // GraphQL shape nests it under `requestedReviewer`, and a team has a slug
      // where a person has a login. All three have to arrive as a name.
      reviewRequests: [
        { __typename: 'User', login: 'alice' },
        { requestedReviewer: { __typename: 'User', login: 'bob' } },
        { __typename: 'Team', name: 'Reviewers', slug: 'reviewers' },
      ],
      latestReviews: [
        { author: { login: 'carol' }, state: 'APPROVED', submittedAt: '2026-07-30T13:57:29Z', body: 'lgtm' },
      ],
    });
    assert.deepStrictEqual(pull.reviewers.map((one) => one.login), ['alice', 'bob', 'reviewers']);
    assert.deepStrictEqual(pull.reviews, [
      { author: { login: 'carol' }, state: 'APPROVED', submittedAt: '2026-07-30T13:57:29Z' },
    ]);
  });
});

describe('the references an item carries', function () {
  it('finds the pull requests GitHub never linked', function () {
    // #163's own linked-pull field was empty — its fix was merged into a
    // release branch rather than the default one, so GitHub made no link. The
    // timeline is the only place those two pull requests exist.
    const refs = mod.crossReferencesOf(TIMELINE);
    assert.deepStrictEqual(refs.map((one) => [one.number, one.relation]), [
      [164, 'mentions'],
      [165, 'closed-by'],
    ]);
    assert.strictEqual(refs[1].title, 'fix: every window and device shows the same tabs');
  });

  it('merges the half each source knows into one row', function () {
    const item = mod.normalizeItem(
      'issue',
      { ...ISSUE_ROW, number: 163, url: 'https://github.com/dnviti/code-agents-webcli/issues/163',
        closedByPullRequestsReferences: [
          { number: 165, url: 'https://github.com/dnviti/code-agents-webcli/pull/165', repository: { nameWithOwner: 'dnviti/code-agents-webcli' } },
        ] },
      mod.crossReferencesOf(TIMELINE),
    );
    const linked = item.references.find((one) => one.number === 165);
    // The field knew the relationship, the timeline knew the title; one row.
    assert.strictEqual(linked.relation, 'closed-by');
    assert.strictEqual(linked.title, 'fix: every window and device shows the same tabs');
    assert.strictEqual(linked.state, 'MERGED');
    assert.strictEqual(item.references.length, 2);
  });

  it('does not let an item reference itself', function () {
    const self = {
      willCloseTarget: false,
      source: {
        __typename: 'Issue', number: 134, title: 'Approval mode',
        url: 'https://github.com/dnviti/code-agents-webcli/issues/134',
        state: 'OPEN', repository: { nameWithOwner: 'dnviti/code-agents-webcli' },
      },
    };
    const timeline = { data: { repository: { issueOrPullRequest: { timelineItems: { nodes: [self] } } } } };
    const item = mod.normalizeItem('issue', ISSUE_ROW, mod.crossReferencesOf(timeline));
    assert.deepStrictEqual(item.references.map((one) => one.number), [151]);
  });

  it('but does keep another repository’s issue of the same number', function () {
    // `gh view` is not asked for a `repository` field — it is the repository the
    // command ran against — so which one this item belongs to has to come off
    // its own URL, or `other/project#134` is dropped as if it were this one.
    const elsewhere = {
      willCloseTarget: false,
      source: {
        __typename: 'Issue', number: 134, title: 'A different 134',
        url: 'https://github.com/other/project/issues/134',
        state: 'OPEN', repository: { nameWithOwner: 'other/project' },
      },
    };
    const timeline = { data: { repository: { issueOrPullRequest: { timelineItems: { nodes: [elsewhere] } } } } };
    const item = mod.normalizeItem('issue', ISSUE_ROW, mod.crossReferencesOf(timeline));
    assert.deepStrictEqual(
      item.references.map((one) => `${one.repo}#${one.number}`),
      ['other/project#134', 'dnviti/code-agents-webcli#151'],
    );
  });

  it('does not list the parent again as something that mentioned it', function () {
    // Writing "part of #100" on the parent puts a cross-reference on this
    // issue's timeline, so the parent arrives twice: once as the hierarchy and
    // once as a mention. Drawing both is the one thing the section exists to
    // stop — and the structured fields carry the title and state, so the
    // mention has nothing to add.
    const mention = (number, title) => ({
      willCloseTarget: false,
      source: {
        __typename: 'Issue', number, title, state: 'OPEN',
        url: `https://github.com/dnviti/code-agents-webcli/issues/${number}`,
        repository: { nameWithOwner: 'dnviti/code-agents-webcli' },
      },
    });
    const timeline = {
      data: { repository: { issueOrPullRequest: { timelineItems: {
        nodes: [mention(100, 'The epic'), mention(77, 'The blocker'), mention(135, 'A child'), mention(90, 'Just a mention')],
      } } } },
    };

    const item = mod.normalizeItem(
      'issue',
      {
        ...ISSUE_ROW,
        parent: { number: 100, title: 'The epic', state: 'OPEN', url: 'https://github.com/dnviti/code-agents-webcli/issues/100' },
        blockedBy: { nodes: [{ number: 77, title: 'The blocker', state: 'OPEN', url: 'https://github.com/dnviti/code-agents-webcli/issues/77' }], totalCount: 1 },
        subIssues: { nodes: [{ number: 135, title: 'A child', state: 'OPEN', url: 'https://github.com/dnviti/code-agents-webcli/issues/135' }], totalCount: 1 },
      },
      mod.crossReferencesOf(timeline),
    );

    assert.strictEqual(item.parent.number, 100);
    assert.deepStrictEqual(
      item.references.map((one) => one.number),
      [90, 151],
      'only what no other section is already drawing',
    );
  });

  it('reads the repository off a url in either shape', function () {
    assert.strictEqual(mod.repoFromUrl('https://github.com/dnviti/code-agents-webcli/issues/134'), 'dnviti/code-agents-webcli');
    assert.strictEqual(mod.repoFromUrl('https://github.example.com/team/thing/pull/9'), 'team/thing');
    assert.strictEqual(mod.repoFromUrl('https://github.com/dnviti/code-agents-webcli'), undefined);
    assert.strictEqual(mod.repoFromUrl(undefined), undefined);
  });

  it('keeps a reference into another repository apart from ours', function () {
    const refs = mod.mergeReferences(
      [{ kind: 'pr', number: 5, repo: 'dnviti/code-agents-webcli', relation: 'closed-by' }],
      [{ kind: 'pr', number: 5, repo: 'other/project', title: 'Elsewhere', relation: 'mentions' }],
    );
    assert.strictEqual(refs.length, 2, 'same number, different repository, different thing');
  });
});

describe('gh answering in a shape this does not know', function () {
  it('drops the row rather than the panel', function () {
    assert.strictEqual(mod.normalizeIssue(null), null);
    assert.strictEqual(mod.normalizeIssue('nope'), null);
    assert.strictEqual(mod.normalizeIssue({ title: 'no number' }), null);
    assert.strictEqual(mod.normalizePull({ number: 0 }), null);
    assert.strictEqual(mod.normalizeItem('pr', undefined), null);
  });

  it('survives every relational field arriving as something else', function () {
    const issue = mod.normalizeIssue({
      number: 7, title: 'Odd', url: 'https://github.com/o/r/issues/7', state: 'OPEN',
      assignees: 'nobody',
      labels: { nodes: [{ name: 'bug' }] },
      milestone: 'not an object',
      parent: 42,
      subIssues: { nodes: 'nope' },
      subIssuesSummary: [],
      blockedBy: null,
      closedByPullRequestsReferences: [{ nothing: true }, { number: 9, url: 'https://github.com/o/r/pull/9' }],
    });
    assert.strictEqual(issue.number, 7);
    assert.deepStrictEqual(issue.labels, [{ name: 'bug' }]);
    assert.ok(!('assignees' in issue));
    assert.ok(!('milestone' in issue));
    assert.ok(!('parent' in issue));
    assert.deepStrictEqual(issue.references.map((one) => one.number), [9]);
  });

  it('reads a timeline that came back as an error', function () {
    assert.deepStrictEqual(mod.crossReferencesOf(null), []);
    assert.deepStrictEqual(mod.crossReferencesOf({ errors: [{ message: 'nope' }] }), []);
    assert.deepStrictEqual(mod.crossReferencesOf({ data: { repository: null } }), []);
  });
});
