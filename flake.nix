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
