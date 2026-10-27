import * as fs from 'fs';
export const DISK_VIEW = {
    exists: (filePath) => fs.existsSync(filePath),
    read: (filePath) => fs.readFileSync(filePath, 'utf-8'),
    isDirectory: (filePath) => {
        try {
            return fs.statSync(filePath).isDirectory();
        }
        catch {
            return false;
        }
    },
};
//# sourceMappingURL=file-view.js.map