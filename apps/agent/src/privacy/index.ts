/** Remove credentials before output is truncated, persisted for delivery, or sent to the panel. */
export function redactText(text: string, secrets: readonly string[] = []) {
  let result = text;
  for (const secret of [
    ...new Set(secrets.filter((value) => value && (value.length >= 8 || text.trim() === value))),
  ].sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[已隐藏]');
  return result.replace(
    /((?:ServerAdminPassword|ServerPassword|RCONPassword)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s?&;]+)/gi,
    '$1[已隐藏]',
  );
}
