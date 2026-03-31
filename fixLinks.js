// fixLinks.js
const fs = require("fs");
const path = require("path");

// Folder containing your HTML files
const PUBLIC_DIR = path.join(__dirname, "public");

// Function to recursively get all HTML files
function getHtmlFiles(dir) {
  let files = [];
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      files = files.concat(getHtmlFiles(fullPath));
    } else if (file.endsWith(".html")) {
      files.push(fullPath);
    }
  });
  return files;
}

// Fix links inside HTML content
function fixLinks(content) {
  // Replace missing slashes or relative paths if needed
  return content.replace(/href="\/?(blog\d*\.html|[\w-]+\.html)"/g, (match, p1) => {
    return `href="/${p1}"`;
  });
}

// Process all HTML files
const htmlFiles = getHtmlFiles(PUBLIC_DIR);

htmlFiles.forEach(file => {
  let content = fs.readFileSync(file, "utf8");
  const fixedContent = fixLinks(content);
  fs.writeFileSync(file, fixedContent, "utf8");
  console.log(`✅ Fixed links in ${file}`);
});

console.log("🎉 All blog & tool links processed successfully!");
