const fs = require("fs");
const path = require("path");

const TOOLS_DIR = path.join(__dirname, "public/tools");

const ADSENSE_SCRIPT = `
<!-- Google AdSense Auto Ads -->
<script async
  src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2756415731978402"
  crossorigin="anonymous"></script>
`;

fs.readdirSync(TOOLS_DIR).forEach(file => {
  if (!file.endsWith(".html")) return;

  const filePath = path.join(TOOLS_DIR, file);
  let content = fs.readFileSync(filePath, "utf8");

  // Skip if already added
  if (content.includes("ca-pub-2756415731978402")) {
    return;
  }

  // Inject before </head>
  content = content.replace(
    /<\/head>/i,
    `${ADSENSE_SCRIPT}\n</head>`
  );

  fs.writeFileSync(filePath, content, "utf8");
});

console.log("✅ AdSense Auto Ads script added to all tool pages");
