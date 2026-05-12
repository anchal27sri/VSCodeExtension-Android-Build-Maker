import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface LauncherInfo {
    packageId: string;
    /** Fully qualified or .RelativeName; consumers should resolve via packageId. */
    activity?: string;
}

/**
 * Resolves the package id and main launcher activity for the project.
 * Prefers the merged manifest produced by the build; falls back to the
 * source manifest. Returns undefined activity if no LAUNCHER intent is found
 * (callers can use the monkey fallback).
 */
export async function getLauncherInfo(folder: vscode.WorkspaceFolder): Promise<LauncherInfo> {
    const root = folder.uri.fsPath;

    // 1. Try merged manifest (most accurate; reflects gradle namespace etc.)
    const mergedPattern = new vscode.RelativePattern(folder, '**/build/intermediates/merged_manifests/**/AndroidManifest.xml');
    const merged = await vscode.workspace.findFiles(mergedPattern, '**/node_modules/**');
    for (const uri of merged) {
        const info = parseManifest(uri.fsPath);
        if (info?.packageId) { return info; }
    }

    // 2. Try source manifests under src/main
    const sourcePattern = new vscode.RelativePattern(folder, '**/src/main/AndroidManifest.xml');
    const sources = await vscode.workspace.findFiles(sourcePattern, '**/build/**');
    // Prefer the one under /app/
    const ordered = [...sources].sort((a, b) => {
        const aw = /\/app\//.test(a.fsPath) ? 0 : 1;
        const bw = /\/app\//.test(b.fsPath) ? 0 : 1;
        return aw - bw;
    });
    for (const uri of ordered) {
        const info = parseManifest(uri.fsPath);
        if (info?.packageId) {
            // If the source manifest omits package=, try to recover from
            // the matching build.gradle(.kts) `namespace` declaration.
            if (!info.packageId) {
                const ns = tryReadNamespace(uri.fsPath);
                if (ns) { info.packageId = ns; }
            }
            return info;
        }
    }

    // 3. Last resort: try to discover namespace from gradle scripts
    const ns = await findGradleNamespace(folder);
    if (ns) { return { packageId: ns }; }

    throw new Error('Could not determine application package id from manifest or gradle scripts.');
}

function parseManifest(filePath: string): LauncherInfo | undefined {
    let text: string;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }

    const pkgMatch = text.match(/<manifest[^>]*\spackage="([^"]+)"/);
    let packageId = pkgMatch ? pkgMatch[1] : '';

    if (!packageId) {
        // The manifest may rely on gradle `namespace`; look in adjacent build script
        const ns = tryReadNamespace(filePath);
        if (ns) { packageId = ns; }
    }

    if (!packageId) { return undefined; }

    // Find <activity> blocks (including <activity-alias>) containing MAIN + LAUNCHER intent filter
    const activityRe = /<(activity(?:-alias)?)\b([\s\S]*?)>([\s\S]*?)<\/\1>/g;
    let m: RegExpExecArray | null;
    while ((m = activityRe.exec(text)) !== null) {
        const attrs = m[2];
        const body = m[3];
        if (
            /android\.intent\.action\.MAIN/.test(body) &&
            /android\.intent\.category\.LAUNCHER/.test(body)
        ) {
            const nameMatch = attrs.match(/android:name="([^"]+)"/);
            const targetMatch = attrs.match(/android:targetActivity="([^"]+)"/);
            const name = (targetMatch?.[1] || nameMatch?.[1] || '').trim();
            if (name) {
                return { packageId, activity: name };
            }
        }
    }

    return { packageId };
}

/**
 * Look in the same module's build.gradle / build.gradle.kts for a
 * `namespace "..."` declaration (AGP 7+).
 */
function tryReadNamespace(manifestPath: string): string | undefined {
    // Walk upward from the manifest to find a build.gradle(.kts).
    let dir = path.dirname(manifestPath);
    const stopAt = path.parse(dir).root;
    for (let i = 0; i < 8 && dir !== stopAt; i++) {
        for (const name of ['build.gradle', 'build.gradle.kts']) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate)) {
                try {
                    const content = fs.readFileSync(candidate, 'utf8');
                    const m = content.match(/namespace\s*[=]?\s*['"]([^'"]+)['"]/);
                    if (m) { return m[1]; }
                } catch {
                    // ignore
                }
            }
        }
        dir = path.dirname(dir);
    }
    return undefined;
}

async function findGradleNamespace(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const pattern = new vscode.RelativePattern(folder, '**/build.gradle{,.kts}');
    const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,build,.gradle}/**', 20);
    for (const f of files) {
        try {
            const content = fs.readFileSync(f.fsPath, 'utf8');
            const m = content.match(/namespace\s*[=]?\s*['"]([^'"]+)['"]/);
            if (m) { return m[1]; }
        } catch {
            // ignore
        }
    }
    return undefined;
}
