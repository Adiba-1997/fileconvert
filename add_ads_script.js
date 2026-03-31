const fs = require("fs");
const path = require("path");

// Path to your tools directory
const toolsDir = path.join(__dirname, "public/tools");

// Script line to insert
const scriptLine = '<script src="/js/ads.js"></script>\n';

// Function to recursively process HTML files
function addScriptToHTML(dir) {
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      addScriptToHTML(fullPath); // Recurse into subdirectories
    } else if (file.endsWith(".html")) {
      let content = fs.readFileSync(fullPath, "utf-8");

      // Only insert if not already present
      if (!content.includes(scriptLine.trim())) {
        // Insert after opening <body> tag
        content = content.replace(
          /<body[^>]*>/i,
          match => `${match}\n${scriptLine}`
        );
        fs.writeFileSync(fullPath, content, "utf-8");
        console.log(`Updated: ${fullPath}`);
      } else {
        console.log(`Already exists: ${fullPath}`);
      }
    }
  });
}

// Run the function
addScriptToHTML(toolsDir);

