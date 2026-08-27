declare module "*/anime2dr/rigger" {
  const Rigger: {
    buildRig(psd: any, opts?: any): any;
    baseName(n: string): string;
    cleanPsdLayers(psd: any): { noisy: number; layers: number };
  };
  export default Rigger;
}
