{
  lib,
  stdenvNoCC,
  bun,
  fetchzip,
}:
let
  packageJson = lib.importJSON ../package.json;
  runtimeDependencies = {
    argparse = fetchzip {
      url = "https://registry.npmjs.org/argparse/-/argparse-2.0.1.tgz";
      sha256 = "1dv896y3piqdv70w06fyj0pp6pm6qdbba13sy78n3jywl4jfizps";
    };
    highlightJs = fetchzip {
      url = "https://registry.npmjs.org/highlight.js/-/highlight.js-${
        packageJson.dependencies."highlight.js"
      }.tgz";
      sha256 = "1c3cy1nq1in2h3rbnyla26fwm1im5fd78fv1d9bbpnm59l7n8www";
    };
    jsYaml = fetchzip {
      url = "https://registry.npmjs.org/js-yaml/-/js-yaml-${packageJson.dependencies."js-yaml"}.tgz";
      sha256 = "0ydq2c65w8d6pjj447dkqvf5vnxbs7asiw8kjlspkrjv5nk4xrp1";
    };
    marked = fetchzip {
      url = "https://registry.npmjs.org/marked/-/marked-${packageJson.dependencies.marked}.tgz";
      sha256 = "0jd33sksb2r016dq24ddxqc7jdjv8b05imfw3vj615mpkl2df6r3";
    };
  };
in
# `bun build --compile` embeds the build-time Bun runtime and its root CA
# store, so the `bun` argument decides which TLS roots the binary trusts.
stdenvNoCC.mkDerivation {
  pname = "pagebin";
  version = packageJson.version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../src
      ../shared
    ];
  };

  nativeBuildInputs = [ bun ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    mkdir -p node_modules
    cp -R ${runtimeDependencies.argparse} node_modules/argparse
    cp -R ${runtimeDependencies.highlightJs} node_modules/highlight.js
    cp -R ${runtimeDependencies.jsYaml} node_modules/js-yaml
    cp -R ${runtimeDependencies.marked} node_modules/marked
    bun build ./src/cli.ts --compile --target=bun-linux-x64 --outfile pagebin
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 pagebin $out/bin/pagebin
    runHook postInstall
  '';

  meta = {
    description = "Securely publish generated HTML artifacts behind protected URLs";
    homepage = "https://github.com/Kabilan108/pagebin";
    license = lib.licenses.mit;
    mainProgram = "pagebin";
    platforms = [ "x86_64-linux" ];
  };
}
