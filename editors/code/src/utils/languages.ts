import * as vscode from "vscode";

interface ExtensionManifest {
  contributes?: {
    languages?: {
      aliases?: string[];
      extensions?: string[];
    }[];
  };
}

export function getLanguages(): Map<string, string> {
  // See https://github.com/microsoft/vscode/issues/145307.
  // `vscode.extensions.all` can't get all extensions across all extension hosts, which causes detecting languages failed in remote host.
  // So when the extension is running in a remote host, we have to use a fallback languages map until the proposed API is finalized.

  return vscode.env.remoteName
    ? getFallback()
    : new Map(
        vscode.extensions.all
          .flatMap(
            (e) =>
              (e.packageJSON as ExtensionManifest)?.contributes?.languages ?? []
          )
          .filter(
            (lang) =>
              (lang.aliases?.length ?? 0 > 0) &&
              (lang.extensions?.length ?? 0 > 0)
          )
          .flatMap<[string, string]>((lang) => {
            const alias = lang.aliases![0];
            return lang.extensions!.map<[string, string]>((ext: string) => [
              ext,
              alias,
            ]);
          })
      );
}

let fallback: Map<string, string> | undefined = undefined;
function getFallback(): Map<string, string> {
  if (!fallback) {
    fallback = new Map([
      [".c", "C"],
      [".cc", "C++"],
      [".cpp", "C++"],
      [".c++", "C++"],
      [".cxx", "C++"],
      [".h", "C++"],
      [".h++", "C++"],
      [".hh", "C++"],
      [".hpp", "C++"],
      [".hxx", "C++"],

      [".ada", "Ada"],
      [".ads", "Ada"],
      [".adb", "Ada"],
      [".as", "ActionScript"],

      [".ceylon", "Ceylon"],
      [".cl", "Common Lisp"],
      [".clj", "Clojure"],
      [".cljc", "Clojure"],
      [".cljs", "Clojure"],
      [".cr", "Crystal"],
      [".cs", "C#"],
      [".coq", "Coq"],
      [".coffee", "CoffeeScript"],
      [".cob", "Cobol"],
      [".cbl", "Cobol"],
      [".ccp", "Cobol"],
      [".cobol", "Cobol"],
      [".cpy", "Cobol"],

      [".d", "D"],
      [".dart", "Dart"],

      [".e", "Eiffel"],
      [".el", "Emacs Lisp"],
      [".elm", "Elm"],
      [".erl", "Erlang"],
      [".ex", "Elixir"],
      [".exs", "Elixir"],

      [".fs", "F#"],
      [".fsi", "F#"],
      [".fsx", "F#"],

      [".f90", "Fortran"],
      [".f", "Fortran"],
      [".f03", "Fortran"],
      [".f08", "Fortran"],
      [".f77", "Fortran"],
      [".f95", "Fortran"],
      [".for", "Fortran"],
      [".fpp", "Fortran"],

      [".go", "Go"],
      [".groovy", "Groovy"],
      [".gvy", "Groovy"],
      [".gy", "Groovy"],
      [".gsh", "Groovy"],

      [".hrl", "Erlang"],
      [".hs", "Haskell"],
      [".lhs", "Haskell"],

      [".idr", "Idris"],
      [".lidr", "Idris"],
      [".ijs", "J"],

      [".java", "Java"],
      [".jl", "Julia"],
      [".js", "JavaScript"],
      [".jsx", "JavaScript JSX"],

      [".kt", "Kotlin"],
      [".kts", "Kotlin"],

      [".lean", "Lean"],
      [".lua", "Lua"],
      [".lisp", "Common Lisp"],
      [".lsp", "Common Lisp"],

      [".m", "*.m"],
      [".ml", "OCaml"],
      [".mli", "OCaml"],
      [".nim", "Nim"],
      [".nix", "Nix"],

      [".php", "PHP"],
      [".pl", "Perl"],
      // [".pl", "Prolog"],
      [".pm", "Perl"],
      [".pony", "Pony"],
      [".purs", "PureScript"],
      [".py", "Python"],

      [".pas", "Pacal"],
      [".dfm", "Pacal"],
      [".dpr", "Pacal"],
      [".inc", "Pacal"],
      [".lpr", "Pacal"],
      [".pp", "Pacal"],

      [".r", "R"],
      [".rd", "R"],
      [".rsx", "R"],
      [".rb", "Ruby"],
      [".rkt", "Racket"],
      [".rs", "Rust"],

      [".raku", "Raku"],
      [".p6", "Raku"],
      [".pl6", "Raku"],
      [".pm6", "Raku"],
      [".pod6", "Raku"],

      [".scala", "Scala"],
      [".scm", "Scheme"],
      [".ss", "Scheme"],
      [".sml", "Standard ML"],
      [".st", "Smalltalk"],
      [".swift", "Swift"],

      [".tcl", "Tcl"],
      [".ts", "TypeScript"],
      [".tsx", "TypeScript JSX"],

      [".vb", "Visual Basic"],

      [".zig", "Zig"],
    ]);
  }

  return fallback;
}
