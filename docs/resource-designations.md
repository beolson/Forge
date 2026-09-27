# Forge Azure resource designations

All Forge-managed Azure resource names use:

`az-{app-code}-{resource-designation}[-{sub-designation}]`

- `app-code`: the project's unique five-letter code, lowercased in resource names.
- `resource-designation`: exactly five lowercase ASCII letters, registered below.
- `sub-designation`: optional, exactly five lowercase ASCII letters, registered below when a resource needs several named parts.
- Do not reuse a designation for a different meaning. Add an entry before introducing a new resource type.
- Keep the name within the Azure service's own length and character limits; this convention does not override service limits.

| Designation | Meaning | First used by | Example |
| --- | --- | --- | --- |
| `resgp` | Azure resource group | Project creation | `az-abcde-resgp` |
| `rgdep` | Subscription deployment record for a project resource group | Project creation through Bicep | `az-abcde-rgdep` |

## Sub-designation registry

No sub-designations are assigned yet. Add a row with its meaning, resource designation, owner, and example before use.

| Sub-designation | Resource designation | Meaning | Owner | Example |
| --- | --- | --- | --- | --- |

GitHub repository names use a separate convention: `gh-{app-code}-{project-name-slug}`. The slug is the lowercase project name with runs of spaces and hyphens replaced by a single hyphen. For example, `My First Project` with code `ABCDE` becomes `gh-abcde-my-first-project`.
