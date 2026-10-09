package dsh.companion;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON reader for the small documents this plugin consumes: DSH HTTP responses and the
 * credential record. Objects become {@link LinkedHashMap}, arrays become {@link ArrayList}, numbers
 * become {@link Long} when integral and {@link Double} otherwise.
 */
public final class JsonParser {
  private final String text;
  private int at;

  private JsonParser(String text) {
    this.text = text;
  }

  /**
   * @param text - one complete JSON document.
   * @return the parsed value: map, list, string, number, boolean, or {@code null}.
   * @throws IllegalArgumentException when the document is malformed or has trailing content.
   */
  public static Object parse(String text) {
    JsonParser parser = new JsonParser(text);
    parser.skipWhitespace();
    Object value = parser.readValue();
    parser.skipWhitespace();
    if (parser.at != text.length()) throw new IllegalArgumentException("unexpected trailing content");
    return value;
  }

  /**
   * Read one member of a parsed object.
   * @param container - a parsed value.
   * @param key - member name.
   * @return the member value, or {@code null} when the container is not an object or lacks the key.
   */
  public static Object member(Object container, String key) {
    if (!(container instanceof Map<?, ?> map)) return null;
    return map.get(key);
  }

  /**
   * Read one string member.
   * @param container - a parsed value.
   * @param key - member name.
   * @return the member text, or {@code null} when it is absent or not a string.
   */
  public static String string(Object container, String key) {
    Object value = member(container, key);
    return value instanceof String text ? text : null;
  }

  /**
   * Read one array member.
   * @param container - a parsed value.
   * @param key - member name.
   * @return the member list, or an empty list when it is absent or not an array.
   */
  public static List<Object> array(Object container, String key) {
    Object value = member(container, key);
    return value instanceof List<?> list ? List.copyOf(list) : List.of();
  }

  private Object readValue() {
    char current = peek();
    return switch (current) {
      case '{' -> readObject();
      case '[' -> readArray();
      case '"' -> readString();
      case 't' -> readLiteral("true", Boolean.TRUE);
      case 'f' -> readLiteral("false", Boolean.FALSE);
      case 'n' -> readLiteral("null", null);
      default -> readNumber();
    };
  }

  private Map<String, Object> readObject() {
    expect('{');
    Map<String, Object> object = new LinkedHashMap<>();
    skipWhitespace();
    if (peek() == '}') {
      at++;
      return object;
    }
    while (true) {
      skipWhitespace();
      String key = readString();
      skipWhitespace();
      expect(':');
      skipWhitespace();
      object.put(key, readValue());
      skipWhitespace();
      char separator = peek();
      at++;
      if (separator == '}') return object;
      if (separator != ',') throw new IllegalArgumentException("expected ',' or '}' at " + at);
    }
  }

  private List<Object> readArray() {
    expect('[');
    List<Object> array = new ArrayList<>();
    skipWhitespace();
    if (peek() == ']') {
      at++;
      return array;
    }
    while (true) {
      skipWhitespace();
      array.add(readValue());
      skipWhitespace();
      char separator = peek();
      at++;
      if (separator == ']') return array;
      if (separator != ',') throw new IllegalArgumentException("expected ',' or ']' at " + at);
    }
  }

  private String readString() {
    expect('"');
    StringBuilder value = new StringBuilder();
    while (true) {
      char current = text.charAt(at++);
      if (current == '"') return value.toString();
      if (current != '\\') {
        value.append(current);
        continue;
      }
      char escaped = text.charAt(at++);
      switch (escaped) {
        case '"' -> value.append('"');
        case '\\' -> value.append('\\');
        case '/' -> value.append('/');
        case 'b' -> value.append('\b');
        case 'f' -> value.append('\f');
        case 'n' -> value.append('\n');
        case 'r' -> value.append('\r');
        case 't' -> value.append('\t');
        case 'u' -> {
          value.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
          at += 4;
        }
        default -> throw new IllegalArgumentException("invalid escape at " + at);
      }
    }
  }

  private Object readLiteral(String literal, Object value) {
    if (!text.startsWith(literal, at)) throw new IllegalArgumentException("invalid literal at " + at);
    at += literal.length();
    return value;
  }

  private Object readNumber() {
    int start = at;
    while (at < text.length() && "+-.eE0123456789".indexOf(text.charAt(at)) >= 0) at++;
    String literal = text.substring(start, at);
    if (literal.isEmpty()) throw new IllegalArgumentException("invalid value at " + start);
    if (literal.indexOf('.') < 0 && literal.indexOf('e') < 0 && literal.indexOf('E') < 0) {
      return Long.parseLong(literal);
    }
    return Double.parseDouble(literal);
  }

  private char peek() {
    if (at >= text.length()) throw new IllegalArgumentException("unexpected end of input");
    return text.charAt(at);
  }

  private void expect(char expected) {
    if (peek() != expected) throw new IllegalArgumentException("expected '" + expected + "' at " + at);
    at++;
  }

  private void skipWhitespace() {
    while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++;
  }
}
