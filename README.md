# ZBK Manager

Implementation is not available yet.

## Responsibility

This repository will own optional authoring and release tools for Zombies Build Kit, including workflows to install, configure, and export project content. It supports creators and maintainers; it is not required to run the core datapack.

## Dependencies

The manager is intended to work with the ZBK datapack and may also handle resource packs, the VR mod, or reusable structures. Exact integration points and dependency versions remain to be audited during migration.

## Source and outputs

Application source, dependency lockfiles, tests, and build tooling belong here. Publish installers and exported packs through the release process rather than committing build output. Caches, generated intermediates, credentials, local worlds, downloaded servers, and user settings are excluded. Packaging must filter repository metadata and local settings independently of Git ignore rules.
