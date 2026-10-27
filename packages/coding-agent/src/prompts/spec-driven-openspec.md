# Dev requirements schema

```yaml
proposalInstruction: |
  Write the requirement change proposal: why it is needed, observable behavior changes, affected new/modified capabilities, and scope/impact. Define acceptance boundaries and unresolved questions. Implementation details, design documents, and task plans are outside this requirements-only graph. This proposal is the foundation for capability delta specifications only.
specsInstruction: |
  Write requirement delta specifications for every affected capability identified in the proposal. Read existing authoritative specs first. Use ADDED, MODIFIED, REMOVED, and RENAMED Requirements sections as appropriate. Each requirement MUST have a clear SHALL/MUST statement and at least one `#### Scenario:` with WHEN/THEN behavior. MODIFIED requirements include the complete replacement requirement and scenarios; never drop existing detail through partial replacements. REMOVED requirements state Reason and Migration; RENAMED requirements use FROM:/TO: headings. A new capability delta starts with `## Purpose` and a meaningful description of at least 50 characters; existing capability purposes remain authoritative. Keep new requirement descriptions within 500 characters and put examples and edge cases in scenarios. Preserve capability paths, unrelated original requirements, and existing requirement blocks unless the requested change affects them. Do not create implementation artifacts.
```
