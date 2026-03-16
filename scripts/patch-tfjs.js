
import fs from 'fs';
import path from 'path';

const filesToPatch = [
    'node_modules/@tensorflow/tfjs-node/dist/nodejs_kernel_backend.js',
    'node_modules/@tensorflow/tfjs-node/dist/io/file_system.js',
    'node_modules/@tensorflow/tfjs-node/dist/kernels/TopK.js',
    'node_modules/@tensorflow/tfjs-node/dist/saved_model.js'
];

filesToPatch.forEach(file => {
    const filePath = path.resolve(file);
    if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf8');
        // If it uses require("util") and it doesn't already have our fix
        if (content.includes('var util_1 = require("util");') && !content.includes('util_1.isNullOrUndefined =')) {
            console.log(`Patching ${file}...`);
            // Add polyfills right after the require statement
            content = content.replace(
                'var util_1 = require("util");',
                'var util_1 = require("util"); if (!util_1.isNullOrUndefined) { util_1.isNullOrUndefined = (val) => val === null || val === undefined; } if (!util_1.isArray) { util_1.isArray = Array.isArray; }'
            );
            fs.writeFileSync(filePath, content);
        } else if (content.includes('const util_1 = require("util");') && !content.includes('util_1.isNullOrUndefined =')) {
            console.log(`Patching ${file} (const)...`);
            content = content.replace(
                'const util_1 = require("util");',
                'const util_1 = require("util"); if (!util_1.isNullOrUndefined) { util_1.isNullOrUndefined = (val) => val === null || val === undefined; } if (!util_1.isArray) { util_1.isArray = Array.isArray; }'
            );
            fs.writeFileSync(filePath, content);
        } else {
            console.log(`${file} already patched or "util" not found as expected.`);
        }
    } else {
        console.warn(`File not found: ${file}`);
    }
});
