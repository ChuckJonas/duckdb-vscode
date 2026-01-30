# Release Process

This document describes how to release a new version of the DuckDB VS Code extension.

## Prerequisites

- Push access to the GitHub repository
- `VSCE_PAT` secret configured in GitHub (see [Refreshing the PAT](#refreshing-the-vsce_pat) if expired)

## Release Steps

### 1. Update the Version

Update the version in `package.json`:

```json
{
  "version": "0.1.0"
}
```

Follow [semantic versioning](https://semver.org/):
- **MAJOR** (1.0.0): Breaking changes
- **MINOR** (0.1.0): New features, backward compatible
- **PATCH** (0.0.1): Bug fixes, backward compatible

### 2. Update the Changelog

Add release notes to `CHANGELOG.md`:

```markdown
## [0.1.0] - 2025-01-28

### Added
- New feature X

### Changed
- Improved Y

### Fixed
- Bug Z
```

### 3. Commit the Changes

```bash
git add package.json CHANGELOG.md
git commit -m "Release v0.1.0"
git push origin main
```

### 4. Create and Push the Tag

```bash
git tag v0.1.0
git push origin v0.1.0
```

This triggers the CI/CD pipeline which will:
1. Build and test on macOS, Ubuntu, and Windows
2. Package the extension
3. Publish to the VS Code Marketplace

### 5. Monitor the Release

- **GitHub Actions**: https://github.com/ChuckJonas/duckdb-vscode/actions
- **Marketplace**: https://marketplace.visualstudio.com/items?itemName=chuckjonas.duckdb

The publish typically takes 2-5 minutes after the workflow completes.

## Refreshing the VSCE_PAT

The Personal Access Token (PAT) expires periodically. If publishing fails with an authentication error, follow these steps:

### 1. Create a New Token

1. Go to https://dev.azure.com
2. Click your profile icon (top right) → **Personal access tokens**
3. Click **+ New Token**
4. Configure:
   - **Name**: `vsce-publish` (or any name)
   - **Organization**: Select **All accessible organizations**
   - **Expiration**: Up to 1 year (choose based on preference)
   - **Scopes**: Click **Custom defined**, then:
     - Find **Marketplace** → check **Manage**
5. Click **Create**
6. **Copy the token immediately** (you won't see it again)

### 2. Update the GitHub Secret

1. Go to https://github.com/ChuckJonas/duckdb-vscode/settings/secrets/actions
2. Click on `VSCE_PAT`
3. Click **Update**
4. Paste the new token
5. Click **Update secret**

### 3. Re-run the Failed Workflow (if needed)

1. Go to the failed workflow run in GitHub Actions
2. Click **Re-run all jobs**

## Quick Release Checklist

- [ ] Version bumped in `package.json`
- [ ] `CHANGELOG.md` updated
- [ ] Changes committed and pushed to `main`
- [ ] Tag created matching version (e.g., `v0.1.0`)
- [ ] Tag pushed to origin
- [ ] CI/CD pipeline passed
- [ ] Extension visible on marketplace

## Troubleshooting

### "engines.vscode mismatch" Error

Ensure `engines.vscode` in `package.json` matches or exceeds `@types/vscode` version in `devDependencies`.

### Publishing Fails with 401/403

The `VSCE_PAT` has likely expired. See [Refreshing the VSCE_PAT](#refreshing-the-vsce_pat).

### Tag Already Exists

If you need to re-release the same version:

```bash
# Delete local and remote tag
git tag -d v0.1.0
git push origin :refs/tags/v0.1.0

# Recreate and push
git tag v0.1.0
git push origin v0.1.0
```
