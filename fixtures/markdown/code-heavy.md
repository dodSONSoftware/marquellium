# Code-Heavy Fixture

Exercises syntax highlighting across common languages (FR-021) and unknown
language fallback.

## Rust

```rust
use std::collections::HashMap;

fn main() {
    let mut map: HashMap<String, i32> = HashMap::new();
    map.insert("answer".into(), 42);
    if let Some(v) = map.get("answer") {
        println!("value: {v}");
    }
}
```

## TypeScript

```ts
interface Point {
  x: number;
  y: number;
}

const shift = <T,>(items: T[], n: number): T[] => {
  if (n <= 0 || items.length === 0) return items;
  return [...items.slice(n), ...items.slice(0, n)];
};
```

## SQL

```sql
WITH active AS (
  SELECT id, name
  FROM users
  WHERE deleted_at IS NULL
)
SELECT u.name, COUNT(o.id) AS order_count
FROM active u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.name
HAVING COUNT(o.id) > 5
ORDER BY order_count DESC
LIMIT 10;
```

## Bash

```bash
#!/usr/bin/env bash
set -euo pipefail

# Process each file
for file in *.md; do
  echo "Processing $file"
  grep -c "TODO" "$file" || true
done
```

## HTML (rendered as code, not as markup)

```html
<!doctype html>
<html>
  <body onload="alert('xss in code block — must stay inert')">
    <script>console.log("still just code")</script>
  </body>
</html>
```

## Unknown language (plain escaped fallback)

```nonsense-language
THIS IS NOT A REAL LANGUAGE
but it must be shown as escaped plain text,
with <tags> left inert and | pipes literal.
```

## Empty fence

```

```

## Single backtick fence

`
single-backtick fence content line
`

## Mixed fence styles

```js
const a = `template
with a line that contains triple backticks: ``` inside
`;
```

```
A plain fence that contains
```
inside? no — three backticks inside a three-backtick fence would close it;
this fence is still open.
```

End.
