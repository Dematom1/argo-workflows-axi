#!/usr/bin/env node
// Session-start hook entry. Prints the offline `ctx` view: no network, no
// credentials, no SSO. `argo-workflows-axi setup hooks` points agents here.
const { mainCtx } = await import("../src/cli.js");
await mainCtx();
