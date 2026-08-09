# Convenience entry points for local development and CI. The npm scripts remain
# the source of truth; these targets only compose and document them.

.DEFAULT_GOAL := help

NPM ?= npm
NODE ?= node
DOCKER ?= docker
FLATPAK ?= flatpak
FLATPAK_BUILDER ?= flatpak-builder
DNF ?= dnf
SUDO ?= sudo

HOST_OS ?= $(shell uname -s)
FLATPAK_ARCH ?= $(shell uname -m)
FLATPAK_REMOTE ?= flathub
FLATPAK_REMOTE_URL ?= https://dl.flathub.org/repo/flathub.flatpakrepo
# Keep this in sync with flatpak.runtimeVersion/baseVersion in electron-builder.yml.
FLATPAK_RUNTIME_VERSION ?= 24.08
FEDORA_DESKTOP_PACKAGES ?= flatpak flatpak-builder libxcrypt-compat rpm-build

ifeq ($(HOST_OS),Linux)
DESKTOP_DIST_DEPS := desktop-linux-deps
endif

# Optional command-line arguments, for example:
#   make web-dev ARGS="--port 4000 --no-open"
#   make test-unit TEST_ARGS="--grep workspace"
#   make desktop-dist DESKTOP_ARGS="--x64"
ARGS ?=
TEST_ARGS ?=
DESKTOP_ARGS ?=
DOCKER_ARGS ?=

IMAGE ?= code-agents-webcli:dev
CONTAINER_NAME ?= code-agents-webcli-dev
DATA_VOLUME ?= code-agents-webcli-data
PORT ?= 32352

.PHONY: help setup install install-ci doctor \
	dev start watch web web-dev web-start web-watch build rebuild web-build \
	desktop desktop-dev desktop-build desktop-pack desktop-dist desktop-linux desktop-linux-deps \
	desktop-linux-system-deps desktop-flatpak-deps \
	desktop-appimage desktop-flatpak desktop-deb desktop-rpm desktop-deb-rpm \
	desktop-windows desktop-macos \
	test test-unit test-browser test-desktop typecheck check check-all ci \
	verify-install docker-build docker-run clean version

help: ## Show this help
	@printf 'Code Agents Web CLI\n\n'
	@printf 'Usage: make <target> [VARIABLE=value]\n\n'
	@awk 'BEGIN { FS = ":.*## "; } \
		/^[a-zA-Z0-9_.-]+:.*## / { printf "  %-22s %s\n", $$1, $$2; }' \
		$(MAKEFILE_LIST)
	@printf '\nUseful overrides:\n'
	@printf '  ARGS="..."           Web/server arguments\n'
	@printf '  TEST_ARGS="..."      Mocha arguments, such as --grep workspace\n'
	@printf '  DESKTOP_ARGS="..."   Extra electron-builder arguments\n'
	@printf '  FLATPAK_ARCH=%s FLATPAK_RUNTIME_VERSION=%s\n' '$(FLATPAK_ARCH)' '$(FLATPAK_RUNTIME_VERSION)'
	@printf '  DOCKER_ARGS="..."    Extra docker run arguments or environment flags\n'
	@printf '  PORT=%s IMAGE=%s\n' '$(PORT)' '$(IMAGE)'

# Setup -----------------------------------------------------------------------

setup: install ## Install development dependencies

install: ## Install dependencies and update the lockfile if needed
	$(NPM) install

install-ci: ## Install exactly from package-lock.json (clean/CI install)
	$(NPM) ci

doctor: ## Check the required tools and report optional ones
	@$(NODE) -e 'const required = require("./package.json").engines.node.match(/\d+(?:\.\d+)*/)[0]; const have = process.versions.node; const parse = (value) => value.split(".").map(Number); const [hm, hn] = parse(have); const [rm, rn] = parse(required); if (hm < rm || (hm === rm && hn < rn)) { console.error(`Node $${required}+ is required; found $${have}.`); process.exit(1); } console.log(`Node $${have} (required: $${required}+)`);'
	@printf 'npm %s\n' "$$($(NPM) --version)"
	@if [ -d node_modules ]; then printf 'Dependencies: installed\n'; else printf 'Dependencies: missing (run make setup)\n'; fi
	@if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then printf 'Browser checks: Chrome/Chromium found\n'; else printf 'Browser checks: Chrome/Chromium not found (local browser tests will skip)\n'; fi
	@if command -v $(DOCKER) >/dev/null 2>&1; then printf 'Docker: available\n'; else printf 'Docker: not found (only needed for docker-* targets)\n'; fi

# Web/server development -------------------------------------------------------

dev: web-dev ## Alias for web-dev

web: web-dev ## Build and run the web app in development mode

web-dev: ## Build and run the web app with development logging
	$(NPM) run dev -- $(ARGS)

start: web-start ## Alias for web-start

web-start: ## Build and run the web app in normal mode
	$(NPM) start -- $(ARGS)

watch: web-watch ## Alias for web-watch

web-watch: ## Rebuild web/server sources and public assets on changes
	$(NPM) run build:watch

# Builds ----------------------------------------------------------------------

build: web-build ## Build the production web/server bundle

web-build: ## Compile server TS, bundle the client, and copy public assets
	$(NPM) run build

rebuild: ## Clean and rebuild the production web/server bundle
	$(MAKE) clean
	$(MAKE) web-build

# Desktop development and packaging ------------------------------------------

desktop: desktop-dev ## Build and launch the Electron desktop app

desktop-dev: ## Build and launch Electron from source
	$(NPM) run desktop -- $(ARGS)

desktop-build: desktop-pack ## Build the unpacked desktop app for this platform

desktop-pack: ## Create an unpacked desktop app in release/
	$(NPM) run desktop:pack -- $(DESKTOP_ARGS)

desktop-dist: $(DESKTOP_DIST_DEPS) ## Create configured installers for this platform (never publish)
	$(NPM) run desktop:dist -- --publish never $(DESKTOP_ARGS)

desktop-linux: desktop-linux-deps ## Build all configured Linux packages (AppImage, Flatpak, deb, rpm)
	$(NPM) run desktop:dist -- --linux AppImage flatpak deb rpm --publish never $(DESKTOP_ARGS)

desktop-appimage: ## Build the Linux AppImage
	$(NPM) run desktop:dist -- --linux AppImage --publish never $(DESKTOP_ARGS)

desktop-linux-deps: desktop-flatpak-deps ## Install Linux desktop packaging dependencies

desktop-linux-system-deps: ## Install Fedora packages needed for Linux desktop packaging
	@if command -v rpm >/dev/null 2>&1 && command -v $(DNF) >/dev/null 2>&1; then \
		missing=''; \
		for package in $(FEDORA_DESKTOP_PACKAGES); do \
			rpm -q "$$package" >/dev/null 2>&1 || missing="$$missing $$package"; \
		done; \
		if [ -n "$$missing" ]; then \
			printf 'Installing Fedora desktop packaging dependencies:%s\n' "$$missing"; \
			if [ "$$(id -u)" -eq 0 ]; then \
				$(DNF) install --assumeyes $$missing; \
			elif command -v $(SUDO) >/dev/null 2>&1; then \
				$(SUDO) $(DNF) install --assumeyes $$missing; \
			else \
				printf '%s\n' 'Root access or sudo is required to install the missing packages.' >&2; \
				exit 1; \
			fi; \
		else \
			printf '%s\n' 'Fedora desktop packaging dependencies are installed.'; \
		fi; \
	else \
		command -v $(FLATPAK) >/dev/null 2>&1 || { printf '%s\n' 'flatpak is required to build the Flatpak package.' >&2; exit 1; }; \
		command -v $(FLATPAK_BUILDER) >/dev/null 2>&1 || { printf '%s\n' 'flatpak-builder is required to build the Flatpak package.' >&2; exit 1; }; \
		command -v rpmbuild >/dev/null 2>&1 || { printf '%s\n' 'rpmbuild is required to build the RPM package.' >&2; exit 1; }; \
		ldconfig -p 2>/dev/null | grep -q 'libcrypt\.so\.1' || { printf '%s\n' 'libcrypt.so.1 is required by Electron Builder fpm (install libcrypt1 or an equivalent compatibility package).' >&2; exit 1; }; \
	fi

desktop-flatpak-deps: desktop-linux-system-deps ## Install the user-level Flatpak runtimes needed for packaging
	@command -v $(FLATPAK) >/dev/null 2>&1 || { printf '%s\n' 'flatpak is required to build the Flatpak package.' >&2; exit 1; }
	@command -v $(FLATPAK_BUILDER) >/dev/null 2>&1 || { printf '%s\n' 'flatpak-builder is required to build the Flatpak package.' >&2; exit 1; }
	$(FLATPAK) remote-add --user --if-not-exists $(FLATPAK_REMOTE) $(FLATPAK_REMOTE_URL)
	$(FLATPAK) install --user --noninteractive $(FLATPAK_REMOTE) \
		runtime/org.freedesktop.Platform/$(FLATPAK_ARCH)/$(FLATPAK_RUNTIME_VERSION) \
		runtime/org.freedesktop.Sdk/$(FLATPAK_ARCH)/$(FLATPAK_RUNTIME_VERSION) \
		app/org.electronjs.Electron2.BaseApp/$(FLATPAK_ARCH)/$(FLATPAK_RUNTIME_VERSION)

desktop-flatpak: desktop-flatpak-deps ## Build the Linux Flatpak bundle
	$(NPM) run desktop:dist -- --linux flatpak --publish never $(DESKTOP_ARGS)

desktop-deb: desktop-linux-system-deps ## Build the Debian/Ubuntu package
	$(NPM) run desktop:dist:linux:deb -- $(DESKTOP_ARGS)

desktop-rpm: desktop-linux-system-deps ## Build the Fedora/RHEL package
	$(NPM) run desktop:dist:linux:rpm -- $(DESKTOP_ARGS)

desktop-deb-rpm: desktop-linux-system-deps ## Build both deb and rpm packages
	$(NPM) run desktop:dist:linux:deb-rpm -- $(DESKTOP_ARGS)

desktop-windows: ## Build the Windows NSIS installer (normally run on Windows)
	$(NPM) run desktop:dist -- --win nsis --publish never $(DESKTOP_ARGS)

desktop-macos: ## Build macOS DMG and ZIP packages (normally run on macOS)
	$(NPM) run desktop:dist -- --mac dmg zip --publish never $(DESKTOP_ARGS)

# Tests and verification ------------------------------------------------------

test: test-unit ## Build and run the unit test suite

test-unit: ## Build and run all Mocha unit tests
	$(NPM) test -- $(TEST_ARGS)

test-browser: ## Build and run the Chrome/Chromium integration checks
	$(NPM) run test:browser

test-desktop: ## Run the Electron attachment integration test
	$(NPM) run test:desktop-attachments

typecheck: ## Type-check the server and browser projects
	$(NPM) run typecheck

check: ## Run the same source checks as CI (typecheck, unit, browser)
	$(MAKE) typecheck
	$(MAKE) test-unit
	$(MAKE) test-browser

check-all: ## Run CI source checks plus the Electron integration test
	$(MAKE) check
	$(MAKE) test-desktop

ci: ## Perform a clean dependency install, then run CI source checks
	$(MAKE) install-ci
	$(MAKE) check

verify-install: ## Verify the documented clean git installation path
	$(NPM) run verify:install

# Containers and utilities ----------------------------------------------------

docker-build: ## Build the local web-server container image
	$(DOCKER) build --tag $(IMAGE) .

docker-run: ## Run the local image on PORT with persistent app data
	$(DOCKER) run --rm --name $(CONTAINER_NAME) \
		--publish $(PORT):32352 \
		--volume $(DATA_VOLUME):/home/appuser/.code-agents-webcli \
		--env GITHUB_OAUTH_CLIENT_ID \
		--env GITHUB_OAUTH_CLIENT_SECRET \
		--env GITHUB_ALLOWED_USER_IDS \
		--env PUBLIC_BASE_URL \
		$(DOCKER_ARGS) $(IMAGE)

clean: ## Remove generated web, test, and desktop build outputs
	$(NODE) -e 'const fs = require("node:fs"); for (const entry of ["dist", "release", "test/browser/bundle.js", "test/browser/workflow-events.json", "test/browser/workflow-failed-events.json"]) fs.rmSync(entry, { recursive: true, force: true });'

version: ## Print the project version
	@$(NODE) -p 'require("./package.json").version'
