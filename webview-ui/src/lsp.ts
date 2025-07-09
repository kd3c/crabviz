export enum SymbolKind {
  FILE = 1,
  MODULE,
  NAMESPACE,
  PACKAGE,
  CLASS,
  METHOD,
  PROPERTY,
  FIELD,
  CONSTRUCTOR,
  ENUM,
  INTERFACE,
  FUNCTION,
  VARIABLE,
  CONSTANT,
  STRING,
  NUMBER,
  BOOLEAN,
  ARRAY,
  OBJECT,
  KEY,
  NULL,
  ENUM_MEMBER,
  STRUCT,
  EVENT,
  OPERATOR,
  TYPE_PARAMETER,
}

export function kindNum2Name(kind: string): string {
  switch (kind) {
    case "1": return "file";
    case "2": return "module";
    case "3": return "namespace";
    case "4": return "package";
    case "5": return "class";
    case "6": return "method";
    case "7": return "property";
    case "8": return "field";
    case "9": return "constructor";
    case "10": return "enum";
    case "11": return "interface";
    case "12": return "func";
    case "13": return "var";
    case "14": return "const";
    case "15": return "string";
    case "16": return "number";
    case "17": return "boolean";
    case "18": return "array";
    case "19": return "object";
    case "20": return "key";
    case "21": return "null";
    case "22": return "enum member";
    case "23": return "struct";
    case "24": return "event";
    case "25": return "operator";
    case "26": return "type parameter";
  }

  return "";
}