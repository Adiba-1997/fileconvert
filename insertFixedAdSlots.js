const fs = require("fs");
const path = require("path");

const toolsDir = path.join(__dirname, "public", "tools");

function fixAdSlots(filePath) {
  let html = fs.readFileSync(filePath, "utf8");
  let changed = false;

  // --- Ensure ad-slot-1 (below navbar) ---
  if (html.includes('id="ad-slot-1"')) {
    // Move if in wrong place
    html = html.replace(/<div class="ad-slot" id="ad-slot-1"><\/div>/g, "");
  }
  if (!html.includes('id="ad-slot-1"')) {
    html = html.replace(/<\/nav>/i, `</nav>\n<div class="ad-slot" id="ad-slot-1"></div>`);
    changed = true;
  }

  // --- Ensure ad-slot-2 (below form) ---
  if (html.includes('id="ad-slot-2"')) {
    html = html.replace(/<div class="ad-slot" id="ad-slot-2"><\/div>/g, "");
  }
  if (!html.includes('id="ad-slot-2"')) {
    html = html.replace(/<\/form>/i, `</form>\n<div class="ad-slot" id="ad-slot-2"></div>`);
    changed = true;
  }

  // --- Ensure ad-slot-3 (before About this tool) ---
  if (html.includes('id="ad-slot-3"')) {
    html = html.replace(/<div class="ad-slot" id="ad-slot-3"><\/div>/g, "");
  }
  if (!html.includes('id="ad-slot-3"')) {
    html = html.replace(
      /<h2>About this tool<\/h2>/i,
      `<div class="ad-slot" id="ad-slot-3"></div>\n<h2>About this tool</h2>`
    );
    changed = true;
  }

  // --- Ensure ad-slot-4 (above footer) ---
  if (html.includes('id="ad-slot-4"')) {
    html = html.replace(/<div class="ad-slot" id="ad-slot-4"><\/div>/g, "");
  }
  if (!html.includes('id="ad-slot-4"')) {
    html = html.replace(/<footer>/i, `<div class="ad-slot" id="ad-slot-4"></div>\n<footer>`);
    changed = true;
  }

  // --- Ensure ad-slot-5 (inside footer, at top) ---
  if (html.includes('id="ad-slot-5"')) {
    // If it’s after </footer>, move it inside
    html = html.replace(/<\/footer>\s*<div class="ad-slot" id="ad-slot-5"><\/div>/gi, "</footer>");
  }
  if (!html.includes('id="ad-slot-5"')) {
    html = html.replace(
      /<footer([^>]*)>/i,
      `<footer$1>\n<div class="ad-slot" id="ad-slot-5"></div>`
    );
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, html, "utf8");
    console.log(`✔ Fixed ad slots in: ${path.basename(filePath)}`);
  } else {
    console.log(`✔ Already correct: ${path.basename(filePath)}`);
  }
}

// Process all tool HTML files
fs.readdirSync(toolsDir).forEach(file => {
  if (file.endsWith(".html")) {
    fixAdSlots(path.join(toolsDir, file));
  }
});
