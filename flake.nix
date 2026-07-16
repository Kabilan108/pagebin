{
  description = "Securely publish generated HTML artifacts behind protected URLs";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      supportedSystems = [ "x86_64-linux" ];
      forAllSystems = lib.genAttrs supportedSystems;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          runtimeDependencies = {
            argparse = pkgs.fetchzip {
              url = "https://registry.npmjs.org/argparse/-/argparse-2.0.1.tgz";
              sha256 = "1dv896y3piqdv70w06fyj0pp6pm6qdbba13sy78n3jywl4jfizps";
            };
            highlightJs = pkgs.fetchzip {
              url = "https://registry.npmjs.org/highlight.js/-/highlight.js-${
                packageJson.dependencies."highlight.js"
              }.tgz";
              sha256 = "1c3cy1nq1in2h3rbnyla26fwm1im5fd78fv1d9bbpnm59l7n8www";
            };
            jsYaml = pkgs.fetchzip {
              url = "https://registry.npmjs.org/js-yaml/-/js-yaml-${packageJson.dependencies."js-yaml"}.tgz";
              sha256 = "1pzkq1qivm58hv0ij1vhsrjrmahqb36f6yzbspi3ppwwik66ksm6";
            };
            marked = pkgs.fetchzip {
              url = "https://registry.npmjs.org/marked/-/marked-${packageJson.dependencies.marked}.tgz";
              sha256 = "0jd33sksb2r016dq24ddxqc7jdjv8b05imfw3vj615mpkl2df6r3";
            };
          };
        in
        rec {
          pagebin = pkgs.stdenvNoCC.mkDerivation {
            pname = "pagebin";
            version = packageJson.version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./src
              ];
            };

            nativeBuildInputs = [ pkgs.bun ];

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
              platforms = supportedSystems;
            };
          };

          default = pagebin;
        }
      );

      apps = forAllSystems (
        system:
        let
          pagebinPkg = self.packages.${system}.pagebin;
        in
        rec {
          pagebin = {
            type = "app";
            program = "${pagebinPkg}/bin/pagebin";
            meta.description = "Securely publish generated HTML artifacts behind protected URLs";
          };

          default = pagebin;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.nodejs_24
              pkgs.wrangler
            ];
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt
      );
    };
}
