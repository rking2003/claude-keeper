# Code signing

Claude Keeper signs its release binaries so they aren't flagged by
SmartScreen / Microsoft Defender (Windows) or Gatekeeper (macOS). Signing is
wired into the release pipeline for **every** release (alpha / beta / stable)
and is **gated off by default** — the pipeline keeps producing unsigned binaries
until the signing credentials below are configured, so nothing breaks before
then.

| Platform | Method | Cost | Status gate |
| --- | --- | --- | --- |
| Windows | [SignPath.io](https://signpath.io) (SignPath Foundation, free for OSS) | Free | repo variable `SIGNPATH_ENABLED == 'true'` |
| macOS | Apple Developer ID + notarization | Paid (Apple Developer Program, ~$99/yr) | presence of `MAC_CSC_LINK` secret |
| Linux | Not signed (AppImage / `.deb` aren't subject to Defender) | — | n/a |

> There is **no free certificate** that instantly clears Defender/SmartScreen.
> Self-signed certificates do not help (and can be flagged worse). The only free
> *effective* route for Windows is the SignPath Foundation OSS program; macOS
> notarization always requires a paid Apple Developer account.

---

## Windows — SignPath Foundation (free for OSS)

SignPath signs binaries as a **service**: the release workflow uploads the
unsigned Windows installers to SignPath.io and downloads the signed binaries
back. There is no certificate file to manage.

### How it works in the pipeline

`.github/workflows/release.yml`:

1. The `package` matrix builds the Windows installers (x64 + arm64) and uploads
   each as a GitHub Actions artifact (`installers-windows-latest-x64`,
   `installers-windows-11-arm-arm64`).
2. The **`sign-windows`** job (only runs when `SIGNPATH_ENABLED == 'true'`)
   resolves each artifact's id and submits it to SignPath via
   [`signpath/github-action-submit-signing-request@v1`](https://github.com/signpath/github-action-submit-signing-request),
   waits for completion, and uploads the signed result as
   `signed-installers-windows-*`.
3. The **`publish`** job downloads the unsigned installers, then downloads the
   `signed-installers-windows-*` artifacts **over them** (same filenames), so the
   signed `.exe`s replace the unsigned ones *before* `SHA256SUMS.txt` is
   generated. Checksums therefore cover the signed binaries.

### One-time setup (maintainer)

1. **Apply** for free OSS code signing at <https://signpath.io/open-source>.
   The repository must be public OSS — Claude Keeper is public and MIT-licensed,
   so it qualifies.
2. After approval, in the SignPath web app create/confirm:
   - an **organization** (note its **Organization ID** — a GUID),
   - a **project** (note its **project slug**),
   - a **signing policy** (e.g. `release-signing`; note its **slug**),
   - an **artifact configuration** (note its **slug**) — see below.
3. In the GitHub repo, **Settings → Secrets and variables → Actions**, add:

   **Secret**
   - `SIGNPATH_API_TOKEN` — SignPath REST API token.

   **Variables**
   - `SIGNPATH_ORGANIZATION_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`
   - `SIGNPATH_ARTIFACT_CONFIG_SLUG` (optional — omit to use the project default)
   - `SIGNPATH_ENABLED` = `true`  ← this flips signing on.

   Organization id, slugs are **not** secret, so they are stored as repository
   *variables*; only the API token is a *secret*.

4. Push a tag (e.g. `v1.0.0-beta`) or re-run the Release workflow. The
   `sign-windows` job now runs and the published Windows binaries are signed.

### SignPath artifact configuration

The artifact submitted per arch is a ZIP containing the NSIS installer (`.exe`),
its `.blockmap`, and the portable `.zip` build. The artifact configuration tells
SignPath which files to Authenticode-sign. A reference copy lives at
[`.signpath/artifact-configuration.xml`](../.signpath/artifact-configuration.xml)
— paste it into the SignPath project's artifact configuration (or upload a
sample artifact and adjust).

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <!-- The submitted GitHub Actions artifact is a ZIP archive containing the
       Windows NSIS installer (.exe), its .blockmap, and the portable .zip. -->
  <zip-file>
    <!-- NSIS installer (Claude.Keeper-<ver>-x64.exe / -arm64.exe).
         product-name constrains signing to Claude Keeper's own binaries. -->
    <pe-file path="*.exe" product-name="Claude Keeper">
      <authenticode-sign/>
    </pe-file>

    <!-- Portable zip build: sign only the app executable, then re-zip.
         OpenConsole.exe (Windows Terminal, Microsoft) is bundled by node-pty's
         ConPTY and is intentionally NOT declared here, so it passes through
         untouched (we must not re-sign a third-party binary). -->
    <zip-file path="*.zip">
      <pe-file path="Claude Keeper.exe" product-name="Claude Keeper">
        <authenticode-sign/>
      </pe-file>
    </zip-file>
  </zip-file>
</artifact-configuration>
```

Notes:
- The `.blockmap` and any other undeclared files pass through unsigned — fine,
  they're unused (no auto-update; electron-builder runs with `publish: null`).
- The portable zip bundles a **third-party** `OpenConsole.exe` (ProductName
  `Windows Terminal`, by Microsoft) under `resources/…/conpty/`. It is
  deliberately left undeclared so SignPath does **not** re-sign it; only the
  app's own `Claude Keeper.exe` is signed.
- Signing the `.exe` invalidates its `.blockmap`, but that metadata isn't
  consumed.
- The `product-name="Claude Keeper"` metadata constraint ensures only Claude
  Keeper's own binaries can be signed under the policy. If a build's PE
  `ProductName` ever differs, SignPath will refuse to sign it until the
  constraint is updated to match. (Verified against the published v1.0.0-beta
  binaries: installer and `Claude Keeper.exe` both report `Claude Keeper`.)

### Activating after approval & verifying the first signed release

Once SignPath approves the project:

1. In SignPath, create the **project** and a **signing policy**, then set the
   project's **artifact configuration** to the contents of
   [`.signpath/artifact-configuration.xml`](../.signpath/artifact-configuration.xml)
   (or upload a sample artifact and adjust to match it).
2. In the GitHub repo, add the secret + variables from
   [One-time setup](#one-time-setup-maintainer) and set `SIGNPATH_ENABLED=true`.
3. Re-cut the tag (or push a new one) to trigger the Release workflow:
   ```bash
   git push origin :refs/tags/v1.0.0-beta   # delete remote tag
   git tag -d v1.0.0-beta
   git tag -a v1.0.0-beta -m "Claude Keeper v1.0.0-beta"
   git push origin v1.0.0-beta
   ```
4. Watch the run. The **Validate SignPath configuration** step (preflight) must
   pass, the **Sign Windows** jobs must succeed, and **Publish** must replace the
   unsigned Windows binaries with the signed ones before checksums are generated.
5. **Verify the signature** on a published Windows asset:
   ```powershell
   # Download Claude.Keeper-<ver>-x64.exe from the release, then:
   Get-AuthenticodeSignature .\Claude.Keeper-1.0.0-beta-x64.exe |
     Select-Object Status, @{n='Signer';e={$_.SignerCertificate.Subject}}
   # Status should be 'Valid' and the signer should be the SignPath Foundation
   # certificate issued for this project.
   ```
   `signtool verify /pa /v <file>.exe` (Windows SDK) gives the full chain if you
   need it.

If the preflight fails, it names exactly which secret/variable is missing. To
publish unsigned again, set `SIGNPATH_ENABLED` to anything other than `true`.

---

## macOS — Apple Developer ID + notarization

macOS signing/notarization is handled natively by electron-builder during the
`package` step. It activates only when a certificate secret is present; with no
secret the app builds unsigned exactly as before.

### Setup

Requires an **Apple Developer Program** membership (paid). Then add these GitHub
**secrets**:

- `MAC_CSC_LINK` — base64-encoded Developer ID Application `.p12` certificate.
- `MAC_CSC_KEY_PASSWORD` — password for that `.p12`.
- `APPLE_ID` — Apple ID email (enables notarization).
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password for notarization.
- `APPLE_TEAM_ID` — Apple Developer Team ID.

When `MAC_CSC_LINK` is set, the `package` step exports
`CSC_LINK`/`CSC_KEY_PASSWORD` (and, if `APPLE_ID` is set, the notarization
variables) only for the mac cells, so Windows/Linux packaging is unaffected.

Entitlements are defined in [`build/entitlements.mac.plist`](../build/entitlements.mac.plist)
(JIT + disabled library-validation so the hardened runtime can load node-pty's
prebuilt `.node`). They are ignored for unsigned builds.

> **Important:** never set `CSC_LINK` to an empty string — electron-builder
> treats `""` as a certificate *path* and fails with `not a file`. The workflow
> only exports it when a real cert is configured.

---

## Verifying downloads (end users)

Every release includes `SHA256SUMS.txt`. To verify an installer:

**Windows (PowerShell):**
```powershell
Get-FileHash .\Claude.Keeper-1.0.0-beta-x64.exe -Algorithm SHA256
```

**macOS / Linux:**
```bash
sha256sum --check --ignore-missing SHA256SUMS.txt
```

A matching hash confirms the file wasn't corrupted or tampered with in transit.

---

## Activation safety check

When `SIGNPATH_ENABLED == 'true'`, the `sign-windows` job first runs a
**Validate SignPath configuration** step that fails fast with an actionable
message if `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID`,
`SIGNPATH_PROJECT_SLUG`, or `SIGNPATH_SIGNING_POLICY_SLUG` is missing — so a
half-configured activation can't silently fail mid-release. To intentionally
publish unsigned, set `SIGNPATH_ENABLED` to anything other than `true` (or
remove it).

---

## Known limitations

- **Installed app executable isn't deep-signed.** The Windows NSIS installer is
  Authenticode-signed as a single PE (which is what clears SmartScreen on
  download). The `Claude Keeper.exe` *inside* the installer is not individually
  re-signed by SignPath; only the copy in the portable `.zip` is. The SignPath
  service model (submit artifact → receive signed artifact) does not extract and
  re-pack the NSIS payload, so deep-signing the installed exe would require
  signing the app before the installer is built. This is low value because the
  signed installer is the file users download and SmartScreen evaluates.
- **GitHub auto-attaches source archives.** Every release/tag gets "Source code
  (zip)" and "Source code (tar.gz)" links generated by GitHub. These are not
  uploaded by our workflow (we upload only binaries) and **cannot** be removed or
  hidden via the API.
- **Linux binaries are not signed.** AppImage and `.deb` aren't subject to
  Defender/SmartScreen; no signing is wired for them.
- **No live "signed" badge.** SignPath doesn't expose a simple per-release status
  badge, so the README uses a static attribution badge (below).

---

## Attribution

Per the SignPath Foundation OSS program, the README credits the donated
certificate:

> Free code signing for Windows binaries is provided by
> [SignPath.io](https://signpath.io), using a certificate from the
> [SignPath Foundation](https://signpath.org).
