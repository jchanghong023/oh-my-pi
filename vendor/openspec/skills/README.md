# OMP built-in OpenSpec skills

OMP discovers all 12 `openspec-*/SKILL.md` workflows natively. No standalone
OpenSpec CLI, skill installation, or generated slash-command files are required.
The bundled skills and OpenSpec implementation update with OMP releases.

Invoke a workflow with `/skill:openspec-propose` (or another bundled skill).
Executable OpenSpec commands use `omp openspec ...`; `openspec/` remains the
project artifact directory.

For a project that has not initialized OpenSpec, explicitly request:

```bash
omp openspec init
```

Initialization creates project configuration only; it does not install skills.
Workflows check for an existing project root and never initialize implicitly.

These bundled skill files are the sole workflow-body source. OMP loads them
directly; there is no skill installer or parallel generated template body.
