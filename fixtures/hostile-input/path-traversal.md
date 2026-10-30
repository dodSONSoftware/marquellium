# Path Traversal Fixture

Every reference below must be rejected by the scoped `local-media:` handler and
the Rust path validation (threat T3, ADR-005). None may read a file outside the
workspace.

![dotdot](../../../etc/passwd)
![dotdot2](../../../../../../etc/hosts)
![encoded](..%2F..%2F..%2Fetc%2Fpasswd)
![url-encoded-2](%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fshadow)
![backslash](..\..\..\etc\passwd)
![absolute](/etc/hosts)
![absolute-2](/Users/USER/.ssh/id_rsa)
![absolute-3](C:\Windows\System32\config\SAM)
![scheme](file:///etc/passwd)
![nested-escape](assets/../../../outside.png)
![nullbyte](assets/diagram.png%00.png)
![symlink-escape](symlink-outside.png)

End of traversal fixture.
