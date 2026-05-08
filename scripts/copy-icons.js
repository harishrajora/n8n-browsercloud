const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'nodes', '_shared', 'browsercloud_logo.png');
const distNodes = path.join(root, 'dist', 'nodes');

for (const dir of fs.readdirSync(distNodes)) {
	const target = path.join(distNodes, dir);
	if (!fs.statSync(target).isDirectory()) continue;
	if (dir === '_shared') continue;
	fs.copyFileSync(src, path.join(target, 'browsercloud_logo.png'));
}
