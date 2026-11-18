# Swagger Exporter

Chrome extension for previewing one documented API endpoint and copying its contract as Markdown. Downloads, text exports, and PDF actions are not included. Documents are processed locally. No backend, accounts, password collection, or API execution.

## Build and install

Requires Node.js 22.18+ and npm.

```sh
npm install
npm run check
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this project's `dist` folder.
4. Sign into Swagger normally, then open an endpoint.
5. Click the extension and **Extract current endpoint**. Keep popup open until preview loads.
6. Confirm the endpoint, review warnings and illustrative examples, then choose **Copy Markdown**. Generated examples start enabled; uncheck them for schema-only context.

For your backend, start at `https://silver.towallet.org/api/docs/`. Its server advertises HTTP Basic authentication. Real authenticated retrieval still needs testing in your browser; successful page login does not guarantee specification retrieval.

If multiple sources are discovered, choose the intended specification. If discovery fails, wait for Swagger to finish loading and retry. If access still fails, save the specification through your authenticated browser and import it with **Import JSON / YAML instead**. Manual specification URL entry is not supported.

## Supported behavior

- OpenAPI 3.0/3.1 and Swagger 2.0 JSON/YAML.
- Swagger UI's common `window.ui` loaded specification/configuration, plus same-origin inline configuration and specification links.
- Exact operation ID and tag fragment matching. Unknown/ambiguous links require manual endpoint selection; no guessed endpoint IDs.
- Original operation fields, inherited path parameters and API metadata, applicable security schemes, and transitive internal `$ref` definitions.
- Cyclic schema references stay references. External references remain visible with warnings; never fetched.
- Readable documentation by default: compact API metadata, parameter/request-field tables, grouped content types, responses, and one authentication section. Raw contract remains selectable.
- Backend-provided examples retained. Illustrative generated examples (enabled by default, can be unchecked) combine property examples, arrays, simple objects, compatible single-`allOf` enum wrappers, and common string-format placeholders. Request samples omit read-only fields; response samples omit write-only fields. Complex/unsupported schemas are not guessed. Generated examples are labeled and are not validated payloads.
- Maximum 10 MB input, structure/reference limits, safe text-only preview.

Readable mode merges path/operation parameters using name and location, retaining operation overrides. Shared request bodies appear once for identical media definitions. Simple object fields and nested objects/array items become readable tables with access flags, enum labels, lengths, and ranges; complex/conflicting composition remains JSON. Arrays include item types. Parameter descriptions have their own column. Recursive/deep schemas stop with explicit notices; use raw mode for full fidelity. Nested referenced models remain available when required.

Raw mode preserves `pathContext`, `operation`, and a `references` map with original definitions. Use raw mode for full source fidelity and technical metadata. Neither mode is a replacement standalone OpenAPI document.

## Privacy and limitations

Browser manages authentication. Extension uses explicit current-tab access (`activeTab`, `scripting`) and no permanent host permissions, storage, telemetry, or cloud connections. Extension pages cannot make network connections. Specification fetches run in the page context, only for an discovered same-origin URL; redirects are rejected.

Page configuration and data are untrusted. Local validation covers envelope/complexity, not full OpenAPI semantic validation. A custom Swagger integration may require file import. Page-level code can observe/interfere with extraction in its own context. Browser authentication and each backend's Swagger integration need manual checks.

Review exports before sharing: source documents can contain private examples, secrets in arbitrary fields, or private URLs. No automatic secret detector can guarantee clean documents. Source page/specification URLs and browser credentials are not added to exports; fields already inside source documents are preserved.

External `$ref` fetching, advanced discriminator/mapping dependency discovery, referenced path-item chains, bulk export, website, MCP, generated SDKs, and Firefox support are outside this build. No HTML/Markdown description rendering; descriptions are displayed safely as plain text.

## Workspace navigation

Popup and workspace follow your system light/dark preference automatically, including controls, tables, code blocks, and warnings. No theme setting or saved preference.

Drag desktop divider to resize endpoint sidebar; document takes remaining width. Focus divider and use Left/Right arrows (10 px, Shift for 50 px), Home/End to move to either edge. No fixed pane-width limits; either pane can shrink to zero, with divider kept accessible inside workspace. Width lasts until workspace closes; mobile uses stacked layout without divider.

Desktop header, endpoint sidebar, and export toolbar stay visible while the document scrolls. Only endpoint list scrolls inside sidebar; search stays visible. Selecting another endpoint returns document to its heading without resetting sidebar position. Changing export options preserves document position. Narrow screens use a collapsible endpoint picker and move focus to selected document heading. Schema/code blocks have no vertical height cap; wide content scrolls horizontally.

Run `npm run test:layout` after building to check these behaviors in headless Chrome (requires `google-chrome`, or set `CHROME_BIN`). Test launches an isolated temporary browser profile. `TMPDIR=/tmp/opencode` selects the preferred temporary location in this environment.

## Development

```sh
npm run dev
npm test
npm run build
```

`npm run dev` rebuilds extension files; reload extension in `chrome://extensions` after changes. For file-import UI development only, `npx vite --host 127.0.0.1` serves `workspace.html` without extension APIs.

`src/documentation.ts` prepares sections for both preview and Markdown; related-schema retention reads structured values, never table text. `src/delivery.ts` owns Chrome workspace delivery, acknowledgements, validation checks, and listener/timeout cleanup. Delivery tests use a browser fake; real extension handoff and authenticated discovery still need manual release checks.

### Manual release checks

- Authenticated Swagger: loaded spec discovery; discovered URL selection; login denial; redirects; network failure.
- Endpoint fragment: exact match; missing operation ID; duplicate IDs; unknown fragment.
- File import: JSON, YAML, Swagger 2.0; invalid/oversized documents; external/missing/cyclic references.
- Preview: keyboard navigation, narrow viewport, long paths/schemas, untrusted HTML shown as text.
- Copy: compare Markdown to source; verify generated examples start enabled and can be disabled; test clipboard denial and retry.
- Privacy: no API operations executed; no external reference requests; no document persistence after closing workspace.
