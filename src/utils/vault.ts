import { App, TFolder } from "obsidian";

/**
 * Ensure a folder exists at `folderPath`, creating intermediate directories
 * as needed. Obsidian's Vault.createFolder throws if the folder already exists,
 * so existence is checked at each step.
 */
export async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(folderPath);
  if (existing instanceof TFolder) return;

  const segments = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const node = app.vault.getAbstractFileByPath(current);
    if (!node) {
      try {
        await app.vault.createFolder(current);
      } catch (e) {
        // Folder may have been created between the check and this call
        // (race condition on startup when the vault index isn't fully ready).
        // Re-throw only if the folder still doesn't exist after the error.
        if (!(app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw e;
      }
    }
  }
}

/**
 * Strip the YAML frontmatter block from a markdown string.
 * Returns the content after the closing --- delimiter (including the newline).
 * If no frontmatter is found, returns the original content unchanged.
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const secondDelimiter = content.indexOf("\n---", 3);
  if (secondDelimiter === -1) return content;
  // Skip past the closing ---\n
  return content.slice(secondDelimiter + 4);
}
