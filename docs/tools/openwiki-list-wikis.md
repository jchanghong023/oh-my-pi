# openwiki_list_wikis

> List repository wikis in a named OpenWiki workspace containing the current repository. This read-only tool does not invoke a model, generate or update a wiki, or change the workspace registry.

In ordinary unrestricted sessions with `tools.xdev=true`, the tool is discoverable at `xd://openwiki_list_wikis`: read that URI for its schema, then write JSON arguments to it. If exposed as a top-level tool, call `openwiki_list_wikis` directly. Mounted execution uses read approval.

Use this tool when workspace membership matters, not as routine task-start discovery. Workspace state is scoped to the active OMP profile. The session working directory determines the Git worktree root; there is no `root` input.

## Inputs

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `workspace` | `string` | Yes | Workspace ID or unique name returned by `openwiki_list_workspaces`, at most 80 characters. The workspace must contain the current registered repository. |

Unexpected fields are rejected. Example arguments: `{"workspace":"payments"}`. Names are matched case-insensitively; an ID is the unambiguous choice.

## Results and errors

The JSON result contains `workspace` (`id`, `name`, `wikiCount`) and `wikis`, an array of member identities (`id`, `name`). Search results identify their supplying `wiki`; pass that ID with the selected page and section anchors to `openwiki_read`.

Invalid parameters or repository context produce `invalid_input`. An unknown workspace, a workspace not containing the current repository, an unregistered current repository, or invalid registry state can produce `invalid_state`. Errors are not empty membership lists.
