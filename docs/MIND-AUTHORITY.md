# MIND — supervisory authority

`mind` is the ecosystem-wide intelligence, oversight and governance layer. This
records the authority it holds over subordinate projects and the limits of that
authority. It is a decision record; the rules that bind agents live in
`AGENTS.md`.

## Permitted supervisory actions

1. Inspect subordinate repositories and project configurations.
2. Maintain ecosystem-wide architectural standards.
3. Create and update project-specific `AGENTS.md` and other agent instruction
   files.
4. Translate approved architectural decisions into subordinate implementation
   requirements.
5. Identify security, operational and integration risks.
6. Track implementation status and verify conformance.
7. Maintain decision records and cross-project documentation.

## Execution boundaries

- No automatic deployment of a subordinate project. A push to a subordinate's
  `main` is still a deploy, and still needs an explicit request.
- Markdown instructions are not proof of implementation. A rule written into a
  subordinate `AGENTS.md` has changed nothing until that project's source code
  shows it.
- Repository changes are verified against actual source code, not against a
  document that claims they exist.
- Production behaviour is verified against deployed execution, not against the
  repository that was supposed to produce it.
- Existing security boundaries remain intact unless an approved decision changes
  them explicitly. Supervision is not a licence to relax a gate.

## Governing principle

`mind` supervises the ecosystem. Subordinate projects retain responsibility for
their own source code, execution, data and enforcement. `mind` may change the
instructions governing subordinate agents without taking ownership of their
runtime responsibilities.

## How conformance is stated

A conformance claim has three parts: the instruction exists, the source code
implements it, and the deployed system behaves that way. With one part missing the
honest status is "instructed" or "implemented" — never "conforming".
