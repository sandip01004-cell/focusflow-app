$files = @("style.css", "manifest.json", "app.js")
foreach ($file in $files) {
    $content = Get-Content -Path $file -Raw
    $newContent = [System.Text.RegularExpressions.Regex]::Replace($content, '(?s)<<<<<<< HEAD\r?\n.*?\r?\n=======\r?\n(.*?)\r?\n>>>>>>> [^\r\n]+', '$1')
    Set-Content -Path $file -Value $newContent -NoNewline
}
