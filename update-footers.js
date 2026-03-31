const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "public");
const TOOLS_DIR = path.join(ROOT_DIR, "tools");

// Footer block (always inserted/updated)
const footerBlock = `
<div class="footer-links">
  <a href="blog.html">Blog</a> |
  <a href="/faq.html">FAQ</a> |
  <a href="/contact.html">Contact</a> |
  <a href="/about.html">About</a> |
  <a href="/privacy.html">Privacy Policy</a> |
  <a href="/terms.html">Terms of Service</a>
</div>
`;

// Hamburger block (always inserted/updated)
const dropdownBlock = `
<div class="footer-dropdown">
  <a href="blog.html">Blog</a>
  <a href="/faq.html">FAQ</a>
  <a href="/contact.html">Contact</a>
  <a href="/about.html">About</a>
  <a href="/privacy.html">Privacy Policy</a>
  <a href="/terms.html">Terms of Service</a>
</div>
`;

function updateFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  let updated = content;

  // --- Update or insert footer-links ---
  if (/<div class="footer-links">([\s\S]*?)<\/div>/i.test(content)) {
    updated = updated.replace(
      /<div class="footer-links">([\s\S]*?)<\/div>/i,
      footerBlock
    );
  } else {
    // If footer-links not found, insert before </body>
    updated = updated.replace(
      /<\/body>/i,
      `${footerBlock}\n</body>`
    );
  }

  // --- Update or insert footer-dropdown ---
  if (/<div class="footer-dropdown">([\s\S]*?)<\/div>/i.test(updated)) {
    updated = updated.replace(
      /<div class="footer-dropdown">([\s\S]*?)<\/div>/i,
      dropdownBlock
    );
  } else {
    // If dropdown not found, insert before </body>
    updated = updated.replace(
      /<\/body>/i,
      `${dropdownBlock}\n</body>`
    );
  }

  // Save changes only if modified
  if (updated !== content) {
    fs.writeFileSync(filePath, updated, "utf8");
    console.log(`✅ Updated or added footer+dropdown in: ${filePath}`);
  } else {
    console.log(`⚠️ No changes in: ${filePath}`);
  }
}

function processDirectory(dir) {
  fs.readdirSync(dir).forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      processDirectory(filePath);
    } else if (file.endsWith(".html")) {
      updateFile(filePath);
    }
  });
}

// Run updates for all pages
processDirectory(ROOT_DIR);
processDirectory(TOOLS_DIR);

console.log("🎉 Done updating all HTML files!");
