# Dangerous URL Schemes Fixture

Every URL below must be blocked by the policy (never executed, rendered inert).
(threat T1, ADR-003)

## javascript: variants

[java](javascript:alert('a'))
[js2](javascript:alert('b'))
[js3](JavaScript:alert('c'))
[js4](jAvAsCrIpT:alert('d'))
[js5](java&#115;cript:alert('e'))
[js6](javascript&colon;alert('f'))
[js7](java
script:alert('g'))
[js8](java	<script>alert('h')</script>pt:alert('i'))
[js9]( javascript:alert('j') )

## vbscript / data

[vb](vbscript:msgbox('x'))
[data1](data:text/html,<script>alert('data')</script>)
[data2](data:application/javascript,alert('data2'))
[data3](data:text/html;base64,PHNjcmlwdD5hbGVydCgnZDInKTwvc2NyaXB0Pg==)

## file: and other schemes

[file](file:///etc/passwd)
[file2](file:///Users/someone/secrets.md)
[ftp](ftp://files.example/x)
[feed](feed://rss.example)

## Attribute injection

[link with "quote injection](https://example.com" onmouseover="alert('attr')")
[img](https://example.com/a.png" onerror="alert('img')")

## Autolink variants

<javascript:alert('autolink')>
<https://ok.example> (this one is fine)

End of dangerous URL fixture.
