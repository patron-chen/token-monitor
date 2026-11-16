// @ts-check
'use strict';

/**
 * Validates and synchronizes npm dependencies before packaging or development.
 * Automatically runs npm install when dependencies are missing or mismatch
 * package.json / scripts/vendor/tokscale.json expectations.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function checkInstalledDependencies()
{
  if (!fs.existsSync('node_modules'))
  {
    return { ok: false, reason: 'node_modules directory does not exist' };
  }

  let semver;
  try
  {
    semver = require('semver');
  }
  catch (_)
  {
    return { ok: false, reason: 'core toolchain dependency (semver) is missing' };
  }

  let pkg;
  try
  {
    pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  }
  catch (error)
  {
    return { ok: false, reason: `failed to read package.json: ${error.message}` };
  }

  const allDeps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  for (const name of Object.keys(allDeps))
  {
    const expected = allDeps[name];
    const pkgPath = path.join('node_modules', ...name.split('/'), 'package.json');
    if (!fs.existsSync(pkgPath))
    {
      return { ok: false, reason: `missing dependency: ${name}` };
    }
    try
    {
      const installedPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (semver && !semver.satisfies(installedPkg.version, expected))
      {
        return {
          ok: false,
          reason: `${name} version mismatch (installed ${installedPkg.version}, expected ${expected})`
        };
      }
    }
    catch (error)
    {
      return { ok: false, reason: `invalid dependency package ${name}: ${error.message}` };
    }
  }

  // Check tokscale platform package alignment if configured
  const vendorPath = path.join('scripts', 'vendor', 'tokscale.json');
  if (fs.existsSync(vendorPath))
  {
    try
    {
      const manifest = JSON.parse(fs.readFileSync(vendorPath, 'utf8'));
      const baseVersion = manifest.baseVersion;
      if (baseVersion)
      {
        const platformKey = `${process.platform}-${process.arch}`;
        const platformInfo = manifest.platforms?.[platformKey];
        if (platformInfo?.package)
        {
          const targetPkgPath = path.join('node_modules', ...platformInfo.package.split('/'), 'package.json');
          if (!fs.existsSync(targetPkgPath))
          {
            return {
              ok: false,
              reason: `missing vendored tokscale target package ${platformInfo.package}`
            };
          }
          const installed = JSON.parse(fs.readFileSync(targetPkgPath, 'utf8')).version;
          if (installed !== baseVersion)
          {
            return {
              ok: false,
              reason: `${platformInfo.package} is ${installed}, but tokscale.json expects ${baseVersion}`
            };
          }
        }
      }
    }
    catch (error)
    {
      return { ok: false, reason: `tokscale manifest check failed: ${error.message}` };
    }
  }

  return { ok: true };
}

function installDependencies()
{
  console.log('[ensure-deps] Synchronizing npm dependencies (npm install)...');
  const result = spawnSync('npm', ['install'], {
    stdio: 'inherit',
    shell: true
  });
  if (result.status !== 0)
  {
    throw new Error(`npm install failed with exit code ${result.status}`);
  }
}

function main()
{
  const check = checkInstalledDependencies();
  if (!check.ok)
  {
    console.log(`[ensure-deps] Dependencies need update (${check.reason}).`);
    installDependencies();
    const recheck = checkInstalledDependencies();
    if (!recheck.ok)
    {
      console.error(`[ensure-deps] Dependencies still unsatisfied after install: ${recheck.reason}`);
      process.exit(1);
    }
    console.log('[ensure-deps] Dependencies are up to date.');
  }
  else
  {
    console.log('[ensure-deps] Dependencies are up to date.');
  }
}

main();
