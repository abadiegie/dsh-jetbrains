package dsh.companion;

import java.util.List;

/**
 * Minimal JSON writer: the companion produces two documents and parses none, so a JSON library would
 * be unused weight. A writer instance builds exactly one object or array; nested values are written
 * by building the nested document first and adding it as an encoded fragment.
 */
public final class Json {
  private final StringBuilder out;
  private final char closing;
  private boolean needComma;

  private Json(String opening, char closing) {
    this.out = new StringBuilder(opening);
    this.closing = closing;
  }

  /** @return a writer for one JSON object. */
  public static Json object() {
    return new Json("{", '}');
  }

  /** @return a writer for one JSON array. */
  public static Json array() {
    return new Json("[", ']');
  }

  /**
   * @param value - text to encode, or {@code null}.
   * @return the JSON string literal.
   */
  public static String quote(String value) {
    if (value == null) return "null";
    StringBuilder quoted = new StringBuilder(value.length() + 2).append('"');
    for (int index = 0; index < value.length(); index++) {
      char current = value.charAt(index);
      switch (current) {
        case '"' -> quoted.append("\\\"");
        case '\\' -> quoted.append("\\\\");
        case '\n' -> quoted.append("\\n");
        case '\r' -> quoted.append("\\r");
        case '\t' -> quoted.append("\\t");
        default -> {
          if (current < 0x20) quoted.append(String.format("\\u%04x", (int) current));
          else quoted.append(current);
        }
      }
    }
    return quoted.append('"').toString();
  }

  /**
   * @param key - member name.
   * @param value - text value, or {@code null} for JSON null.
   * @return this writer.
   */
  public Json field(String key, String value) {
    return fieldRaw(key, quote(value));
  }

  /**
   * @param key - member name.
   * @param value - integer value.
   * @return this writer.
   */
  public Json field(String key, long value) {
    return fieldRaw(key, Long.toString(value));
  }

  /**
   * @param key - member name.
   * @param value - boolean value.
   * @return this writer.
   */
  public Json field(String key, boolean value) {
    return fieldRaw(key, Boolean.toString(value));
  }

  /**
   * @param key - member name.
   * @param encodedValue - an already encoded JSON value, such as a nested {@link #build()} result.
   * @return this writer.
   */
  public Json fieldRaw(String key, String encodedValue) {
    separate();
    out.append(quote(key)).append(':').append(encodedValue);
    return this;
  }

  /**
   * @param value - text element.
   * @return this writer.
   */
  public Json item(String value) {
    return itemRaw(quote(value));
  }

  /**
   * @param encodedValue - an already encoded JSON value.
   * @return this writer.
   */
  public Json itemRaw(String encodedValue) {
    separate();
    out.append(encodedValue);
    return this;
  }

  /**
   * @param values - text elements in order.
   * @return this writer.
   */
  public Json items(List<String> values) {
    for (String value : values) item(value);
    return this;
  }

  /** @return the complete document. */
  public String build() {
    return out.append(closing).toString();
  }

  private void separate() {
    if (needComma) out.append(',');
    needComma = true;
  }
}
