import * as os from "os";
import * as yaml from "js-yaml";
import { readFile, pathExists } from "fs-extra";
import * as idfConf from "../../idfConfiguration";
import { Logger } from "../../logger/logger";
import * as utils from "../../utils";
import * as vscode from "vscode";

class ReHintPair {
  re: string;
  hint: string;
  match_to_output: boolean;

  constructor(re: string, hint: string, match_to_output: boolean = false) {
    this.re = re;
    this.hint = hint;
    this.match_to_output = match_to_output;
  }
}

class ErrorHint {
  public type: "error" | "hint";
  public children: ErrorHint[] = [];

  constructor(public label: string, type: "error" | "hint") {
    this.type = type;
  }

  addChild(child: ErrorHint) {
    this.children.push(child);
  }
}

export class ErrorHintProvider implements vscode.TreeDataProvider<ErrorHint> {
  constructor(private context: vscode.ExtensionContext) {}
  private _onDidChangeTreeData: vscode.EventEmitter<
    ErrorHint | undefined | null | void
  > = new vscode.EventEmitter<ErrorHint | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    ErrorHint | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private data: ErrorHint[] = [];

  async searchError(errorMsg: string, workspace) {
    const espIdfPath = idfConf.readParameter(
      "idf.espIdfPath",
      workspace
    ) as string;
    const version = await utils.getEspIdfFromCMake(espIdfPath);

    if (utils.compareVersion(version.trim(), "5.0") === -1) {
      this.data.push(
        new ErrorHint(
          `Error hints feature is not supported in ESP-IDF version ${version}`,
          "error"
        )
      );
      this._onDidChangeTreeData.fire();
      return;
    }

    const hintsPath = getHintsYmlPath(espIdfPath);

    try {
      if (!(await pathExists(hintsPath))) {
        Logger.infoNotify(`${hintsPath} does not exist.`);
        return;
      }

      const fileContents = await readFile(hintsPath, "utf-8");

      if (!isValidYaml(fileContents)) {
        Logger.infoNotify(`File ${hintsPath} is not a valid YAML file.`);
        return;
      }
      const hintsData = yaml.load(fileContents);

      const reHintsPairArray: ReHintPair[] = this.loadHints(hintsData);

      this.data = [];
      for (const hintPair of reHintsPairArray) {
        const match = new RegExp(hintPair.re, "i").exec(errorMsg);
        if (match) {
          let finalHint = hintPair.hint;

          if (hintPair.match_to_output && hintPair.hint.includes("{}")) {
            // Replace {} with the first capturing group from the regex match
            finalHint = hintPair.hint.replace("{}", match[0]);
          }

          const error = new ErrorHint(hintPair.re, "error");
          const hint = new ErrorHint(finalHint, "hint");
          error.addChild(hint);
          this.data.push(error);
        } else {
          // Extract parts from the regex pattern and split them by the '|' character
          const regexParts = Array.from(hintPair.re.matchAll(/\(([^)]+)\)/g))
            .map((m) => m[1].split("|"))
            .flat();

          if (
            regexParts.some((part) =>
              errorMsg.toLowerCase().includes(part.toLowerCase())
            )
          ) {
            let finalHint = hintPair.hint;

            const matchedSubstring = regexParts.find((part) =>
              errorMsg.toLowerCase().includes(part.toLowerCase())
            );
            finalHint = hintPair.hint.replace("{}", matchedSubstring);

            const error = new ErrorHint(hintPair.re, "error");
            const hint = new ErrorHint(finalHint, "hint");
            error.addChild(hint);
            this.data.push(error);
          }
        }
      }

      if (this.data.length === 0) {
        for (const hintPair of reHintsPairArray) {
          if (hintPair.re.toLowerCase().includes(errorMsg.toLowerCase())) {
            const error = new ErrorHint(hintPair.re, "error");
            const hint = new ErrorHint(hintPair.hint, "hint");
            error.addChild(hint);
            this.data.push(error);
          }
        }
      }

      if (!this.data.length) {
        this.data.push(
          new ErrorHint(`No hints found for ${errorMsg}`, "error")
        );
      }

      this._onDidChangeTreeData.fire();
    } catch (error) {
      Logger.errorNotify(
        `An error occurred while processing the hints file: ${error.message}`,
        error
      );
    }
  }

  private loadHints(hintsArray: any): ReHintPair[] {
    let reHintsPairArray: ReHintPair[] = [];

    for (const entry of hintsArray) {
      if (entry.variables && entry.variables.length) {
        for (const variableSet of entry.variables) {
          const reVariables = variableSet.re_variables;
          const hintVariables = variableSet.hint_variables;

          let re = this.formatEntry(reVariables, entry.re);
          let hint = this.formatEntry(hintVariables, entry.hint);

          reHintsPairArray.push(
            new ReHintPair(re, hint, entry.match_to_output)
          );
        }
      } else {
        let re = String(entry.re);
        let hint = String(entry.hint);

        if (!entry.match_to_output) {
          re = this.formatEntry([], re);
          hint = this.formatEntry([], hint);
        }

        reHintsPairArray.push(new ReHintPair(re, hint, entry.match_to_output));
      }
    }

    return reHintsPairArray;
  }

  private formatEntry(vars: string[], entry: string): string {
    let i = 0;
    while (entry.includes("{}")) {
      entry = entry.replace("{}", "{" + i++ + "}");
    }
    const result = entry.replace(
      /\{(\d+)\}/g,
      (_, idx) => vars[Number(idx)] || ""
    );
    return result;
  }

  getTreeItem(element: ErrorHint): vscode.TreeItem {
    let treeItem = new vscode.TreeItem(element.label);

    if (element.type === "error") {
      if (element.label.startsWith("No hints found")) {
        treeItem.label = `⚠️ ${element.label}`;
      } else {
        treeItem.label = `🔍 ${element.label}`;
        treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded; // Ensure errors are expanded by default
      }
    } else if (element.type === "hint") {
      treeItem.label = `💡 ${element.label}`;
    }

    return treeItem;
  }

  getChildren(element?: ErrorHint): Thenable<ErrorHint[]> {
    if (element) {
      return Promise.resolve(element.children); // Return children if there's a parent element
    } else {
      return Promise.resolve(this.data);
    }
  }
}

function getHintsYmlPath(espIdfPath: string): string {
  const separator = os.platform() === "win32" ? "\\" : "/";
  return `${espIdfPath}${separator}tools${separator}idf_py_actions${separator}hints.yml`;
}

function isValidYaml(fileContents: string): boolean {
  try {
    yaml.load(fileContents);
    return true;
  } catch (e) {
    return false;
  }
}
