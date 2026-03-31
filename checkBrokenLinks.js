const fs = require("fs");
const path = require("path");

// === CONFIG ===
const publicDir = path.join(__dirname, "public");
const toolsDir = path.join(publicDir, "tools");
const brokenLinks = [];

// === Resolve link to actual file ===
function resolveUrlToFile(href, sourceFile) {
  // Ignore external, anchors, JS, and internal system links
  if (
    !href ||
    href === "/" ||
    href.startsWith("#") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:") ||
    href.startsWith("javascript:") ||
    href.startsWith("http") || // ✅ Skip all external URLs (Google Fonts, CDN, etc.)
    href.includes("ads.txt") ||
    href.includes("sitemap") ||
    href.includes("robots.txt")
  ) {
    return null;
  }

  let filePath;

  // --- Handle URLs like /tar-to-zip/ or /pdf-to-word/ ---
  if (href.startsWith("/") && href.endsWith("/")) {
    const toolName = href.replace(/\//g, ""); // remove slashes
    filePath = path.join(toolsDir, `${toolName}.html`);
  }
  // --- Handle relative paths ---
  else if (!href.startsWith("/")) {
    filePath = path.resolve(path.dirname(sourceFile), href);
  }
  // --- Handle absolute URLs like /about.html ---
  else {
    filePath = path.join(publicDir, href);
  }

  // Handle folder URLs (e.g. /pdf-tools/)
  if (!path.extname(filePath)) {
    filePath = path.join(filePath, "index.html");
  }

  return filePath;
}

// === Scan directories recursively ===
function scanDirectory(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      scanDirectory(fullPath);
    } else if (file.endsWith(".html")) {
      checkFile(fullPath);
    }
  }
}

// === Check a single file ===
function checkFile(filePath) {
  const html = fs.readFileSync(filePath, "utf8");
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);

  for (const href of links) {
    const resolved = resolveUrlToFile(href, filePath);
    if (!resolved) continue; // skip ignored/external links

    if (!fs.existsSync(resolved)) {
      brokenLinks.push({
        source: filePath.replace(publicDir, ""),
        href,
      });
    }
  }
}

// === Run ===
console.log("🔍 Scanning for broken links...");
scanDirectory(publicDir);

if (brokenLinks.length === 0) {
  console.log("✅ No broken links found!");
} else {
  console.log(`⚠️ Found ${brokenLinks.length} broken links:\n`);
  brokenLinks.forEach((b, i) => {
    console.log(`${i + 1}. File: ${b.source}\n   → Broken link: ${b.href}\n`);
  });

  // Save report
  const report = brokenLinks
    .map((b, i) => `${i + 1}. File: ${b.source}\n   → Broken link: ${b.href}\n`)
    .join("\n");
  fs.writeFileSync("broken-links-report.txt", report);
  console.log("📝 Report saved: broken-links-report.txt");
}
