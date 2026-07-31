<!-- GENERATED MIRROR — DO NOT EDIT BY HAND -->

> **This repository is a generated, dist-only mirror of `@hellave/js-sdk`.**
>
> Source of truth is `agenpocomp/Hellave-SDKS` (`packages/js`). This repo contains only
> the contents of `npm pack` — `dist/`, `package.json`, `README.md` — so that consumers
> can `npm install` the SDK over the network without access to the private source repo.
> `scripts` are stripped because there is nothing to build here.
>
> Refresh it by re-running the SDK release for a new tag; never commit changes directly.

# @hellave/js-sdk

Browser-first, framework-agnostic ESM SDK for participating in Hellave rooms.

The package is pre-1.0 while the Production Core contract is completed. It attaches
through one Public Edge, returns a server-authoritative `Conference`, exposes
capability-checked lobby decisions, and publishes real microphone media through stable
domain objects while WebRTC and media credentials stay internal to the SDK. See the
[repository index](https://github.com/agenpocomp/Hellave-SDKS) for immutable internal
installation and release verification. Backend setup and the complete callable API are
in the separate
[integration guide](https://github.com/agenpocomp/Hellave-SDKS/blob/main/docs/integration-guide.md).
