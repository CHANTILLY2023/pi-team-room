# Open-Source Release Checklist

Status: public GitHub repository is available; npm publishing is not authorized yet.

## Identity

- [x] Candidate package name changed to `pi-team-room`.
- [x] Package is `private: true` to prevent accidental npm publication.
- [x] Public PI extension entry points to `team-runtime/standalone-extension.ts`.
- [x] Public GitHub repository created with a clean initial history:
  `https://github.com/CHANTILLY2023/pi-team-room`.
- [ ] Maintainer confirms npm owner and issue URL before npm publication.

## License And Attribution

- [x] MIT license file added.
- [x] NOTICE records derivation from `pi-messenger` by Nico Bailon.
- [x] NOTICE records Clowder as design inspiration, not vendored code.
- [ ] Maintainer/legal review confirms final copyright line.

## Privacy

- [x] `.pi-subagents/` ignored.
- [x] npm package whitelist excludes internal retrospective docs.
- [x] README and SECURITY warn against publishing `.pi/`, `.pi-subagents/`, `work/`, tokens, PINs and connector config.
- [x] Public Git push used a fresh repository generated from the npm package
  whitelist, not the working repository's dirty history.

## Runtime Behavior

- [x] Empty default Team initializes only from detected access methods and PI models.
- [x] Existing Teams do not auto-add/remove members when capabilities refresh.
- [x] Legacy default Kimi/Grok binding repair remains compatible.
- [x] Connector doctor remains local-only unless `probe` is requested.
- [ ] Real connector probes require explicit maintainer-approved scope.

## Package And Install

- [x] CLI helper supports `setup`, `doctor` and `uninstall` for source/GitHub
  installs.
- [x] Helper still does not write to `~/.pi` by default; installation requires
  explicit `setup` or the compatibility `--legacy-copy` alias.
- [x] `--legacy-copy` excludes `.pi`, `.pi-subagents`, `work`, lockfiles and scratch files.
- [x] Local setup backs up an existing extension copy before replacing it and
  uninstall leaves project `.pi/messenger/` data untouched.
- [x] `npm pack --dry-run --ignore-scripts` reviewed: 86 files, no `.pi`, `.pi-subagents`, `work` or internal retrospective docs.
- [x] Local tarball install smoke passed in a temporary project with `--ignore-scripts`.
- [ ] Clean temporary HOME install with PI native package flow after final package name is confirmed.

## Verification

- [x] Targeted regression: `npm test -- tests/team-runtime/extension.test.ts tests/install-cli.test.ts tests/team-runtime/standalone-extension.test.ts`.
- [x] Full `npm test`: 61 files, 670 tests passed.
- [x] `npm run typecheck`.
- [x] `npm run typecheck:tests`.
- [x] Final `npm pack --dry-run --json --ignore-scripts` and file list audit.
- [x] Browser smoke on desktop 1440x1000 and mobile 390x844 in an isolated mock Team room.
