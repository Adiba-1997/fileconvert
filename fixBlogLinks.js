const fs = require("fs");
const path = require("path");

// Directory containing your tool pages
const toolsDir = path.join(__dirname, "public", "tools");

// Function to recursively fix files
function fixLinksInDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      fixLinksInDir(fullPath); // go deeper if needed
    } else if (file.endsWith(".html")) {
      let content = fs.readFileSync(fullPath, "utf8");

      // Replace href="blog.html" → href="/blog.html"
      const updated = content.replace(/href\s*=\s*["']blog\.html["']/g, 'href="/blog.html"');

      if (updated !== content) {
        fs.writeFileSync(fullPath, updated, "utf8");
        console.log(`✅ Fixed: ${file}`);
      }
    }
  }
}

console.log("🔍 Scanning /public/tools/ for blog link fixes...");
fixLinksInDir(toolsDir);
console.log("🎉 All blog links fixed successfully!");
