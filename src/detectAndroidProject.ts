import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Determines whether the given workspace folder looks like an Android project.
 * Detection markers (any of):
 *   - settings.gradle(.kts) at root AND a gradle wrapper / build script
 *   - any AndroidManifest.xml file in the workspace
 *   - gradle.properties referencing android.useAndroidX
 */
export async function isAndroidProject(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const root = folder.uri.fsPath;

    const hasFile = (rel: string) => fs.existsSync(path.join(root, rel));

    const hasSettings = hasFile('settings.gradle') || hasFile('settings.gradle.kts');
    const hasBuildScript = hasFile('build.gradle') || hasFile('build.gradle.kts');
    const hasWrapper = hasFile('gradlew') || hasFile('gradlew.bat');

    if (hasSettings && (hasBuildScript || hasWrapper)) {
        return true;
    }

    // Look for an AndroidManifest.xml anywhere (limited search).
    const manifestPattern = new vscode.RelativePattern(folder, '**/AndroidManifest.xml');
    const excludePattern = '**/{node_modules,build,.gradle,out,dist}/**';
    const manifests = await vscode.workspace.findFiles(manifestPattern, excludePattern, 1);
    if (manifests.length > 0) {
        return true;
    }

    // Last-resort: gradle.properties with android.useAndroidX
    try {
        const gp = path.join(root, 'gradle.properties');
        if (fs.existsSync(gp)) {
            const txt = fs.readFileSync(gp, 'utf8');
            if (/android\.useAndroidX/.test(txt)) {
                return true;
            }
        }
    } catch {
        // ignore
    }

    return false;
}

/**
 * Resolves the single Android workspace folder to operate on. If there are
 * multiple Android folders, prompts the user.
 */
export async function resolveAndroidFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const matches: vscode.WorkspaceFolder[] = [];
    for (const f of folders) {
        if (await isAndroidProject(f)) {
            matches.push(f);
        }
    }
    if (matches.length === 0) {
        return undefined;
    }
    if (matches.length === 1) {
        return matches[0];
    }
    const pick = await vscode.window.showQuickPick(
        matches.map(m => ({ label: m.name, description: m.uri.fsPath, folder: m })),
        { placeHolder: 'Select the Android project folder' }
    );
    return pick?.folder;
}
