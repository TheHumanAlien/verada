// Makes the Next static export hash-agnostic so one build works under
// /bzz/<hash>/, on a bzz gateway subdomain and at an ENS gateway root.
//
//  1. HTML: root-absolute "/_next/..." references become depth-relative.
//  2. Webpack runtime: the hard-coded public path "/_next/" becomes an
//     expression derived from the runtime script's own URL, so lazy chunks load
//     from wherever the bundle is served.
//  3. 404.html (the Swarm error document) is served at arbitrary depths, so it is
//     replaced by a self-contained page with no external assets. It also routes the
//     plain-DNS form `<site>/<label>` to `token/?label=<label>`.
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

export function relativizeHtml(html, depth) {
  const prefix = depth === 0 ? "./" : "../".repeat(depth);
  return html.replace(/(["'(=])\/_next\//g, `$1${prefix}_next/`);
}

// Script URL looks like <root>/_next/static/chunks/webpack-<hash>.js; strip the last three segments.
const RUNTIME_PUBLIC_PATH =
  '(function(){try{var s=document.currentScript&&document.currentScript.src;if(s){return new URL("../../",s).pathname}}catch(e){}return"/_next/"})()';

export function patchRuntime(js) {
  return js.replace(/\.p="\/_next\/"/g, `.p=${RUNTIME_PUBLIC_PATH}`);
}

/**
 * Relative URL of the token page for a one-segment path such as `/pepe` (or `/bzz/<ref>/pepe`),
 * or null when the path is not a token label. Mirrors `isValidLabel` in @verada/sdk. Inlined into
 * 404.html via toString(), so it must stay self-contained plain JavaScript.
 */
export function labelRedirect(pathname) {
  var p;
  try {
    p = decodeURIComponent(pathname);
  } catch (e) {
    return null;
  }
  var bzz = p.match(/^\/bzz\/[0-9a-fA-F]{64}(\/.*)?$/);
  var rest = bzz ? bzz[1] || "/" : p;
  var seg = rest.match(/^\/([^/]+)(\/)?$/);
  if (!seg) return null;
  var label = seg[1].toLowerCase();
  if (label.length < 3 || label.length > 63 || !/^[a-z0-9-]+$/.test(label)) return null;
  if (label.charAt(0) === "-" || label.charAt(label.length - 1) === "-") return null;
  if (label.length >= 4 && label.charAt(2) === "-" && label.charAt(3) === "-") return null;
  // Real routes are never redirected to a token page.
  if (["launch", "causes", "governance", "token", "agent", "404"].indexOf(label) !== -1) return null;
  // Relative to the current document: "./" for /pepe, "../" for /pepe/.
  return (seg[2] ? "../" : "./") + "token/?label=" + label;
}

export const NOT_FOUND_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found - Verada</title></head>
<body><main><h1>Page not found</h1>
<p><a id="home" href="./">Back to the start</a></p></main>
<script>
${labelRedirect.toString()}
// Plain-DNS token pages: <site>/<label> opens the token page for that label.
var target = labelRedirect(location.pathname);
if (target) location.replace(target);
// The error document is served at any depth; recover the bundle root from /bzz/<ref>/ when present.
var m = location.pathname.match(/^\\/bzz\\/[^/]+\\//);
document.getElementById("home").href = m ? m[0] : "/";
</script></body></html>
`;

// Run directly (not imported by tests). Compared as real file URLs so a symlinked or spaced path still runs.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let htmlCount = 0;
  let patched = 0;
  for (const file of walk(out)) {
    if (file.endsWith(".html")) {
      const rel = relative(out, file);
      if (rel === "404.html") continue;
      const depth = rel.split("/").length - 1;
      writeFileSync(file, relativizeHtml(readFileSync(file, "utf8"), depth));
      htmlCount++;
    } else if (file.endsWith(".js") && /\/webpack-[^/]*\.js$/.test(file)) {
      const src = readFileSync(file, "utf8");
      const next = patchRuntime(src);
      if (next !== src) {
        writeFileSync(file, next);
        patched++;
      }
    }
  }
  writeFileSync(join(out, "404.html"), NOT_FOUND_HTML);
  console.log(`postexport: relativized ${htmlCount} html files, patched ${patched} runtime file(s), wrote 404.html`);
}
