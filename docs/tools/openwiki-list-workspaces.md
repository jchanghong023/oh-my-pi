# openwiki_list_workspaces

> List named OpenWiki workspaces containing the current or another reachable repository wiki. This read-only tool does not invoke a model, generate or update a wiki, or change the workspace registry.

In ordinary unrestricted sessions with `tools.xdev=true`, the tool is discoverable at `xd://openwiki_list_workspaces`: read that URI for its schema, then write JSON arguments to it. If exposed as a top-level tool, call `openwiki_list_workspaces` directly. Mounted execution uses read approval.

Use this tool when workspace membership or the active selection matters, not as routine task-start discovery. Workspace state is scoped to the active OMP profile. The session working directory determines the Git worktree root; there is no `root` input.

## Inputs

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `wiki` | `string` | No | Known reachable wiki ID, at most 64 characters. Omit for the current repository. |

Unexpected fields are rejected. Use `{}` to inspect the current repository. A different wiki must share a workspace with the registered current repository; a local fallback identity does not authorize access to registered wikis.

## Results and errors

The JSON result contains `wiki` (`id`, `name`), `workspaces` (each with `id`, `name`, `wikiCount`), and `activeWorkspace` when a persistent selection exists. The workspace array can be empty. For a workspace containing the current repository, pass its ID to `openwiki_list_wikis` to inspect members or to `openwiki_search` to select that scope. A name can also be used when unique; a workspace returned for another wiki does not necessarily contain the current repository.

Invalid parameters or repository context produce `invalid_input`. An unknown or unreachable wiki, an unregistered current repository when targeting another wiki, or invalid registry state can produce `invalid_state`. Errors are not empty workspace lists.
