using P7m.Engine.Core.Rigging;
using P7m.Engine.Core.SharedMemory;
using P7m.Engine.Ipc;
using P7m.Engine.Ipc.Protocol;

namespace P7m.Engine.Runtime;

/// <summary>
/// Constrói o manifesto de capacidades servido por <c>engine/describe</c>.
///
/// É por aqui que a engine "se apresenta" ao ecossistema: cada subsistema
/// declara seus limites reais (extraídos das constantes do núcleo DOD), seus
/// layouts binários (derivados por reflexão das structs — nunca hardcoded) e
/// os ganchos de edição visual (<c>editor</c>) que o middleware repassa ao
/// editor Electron para materializar painéis, gizmos e tipos de nó.
/// </summary>
public static class EngineDescriptor
{
    public static object BuildManifest(SkeletonStore skeletons) => new
    {
        engine = new
        {
            name = EngineChannel.ClientName,
            version = EngineChannel.ClientVersion,
            protocolVersion = JsonRpcProtocol.ProtocolVersion,
        },
        subsystems = new
        {
            rigging = new
            {
                status = "available",
                limits = new Dictionary<string, double>
                {
                    ["maxSkeletons"] = skeletons.Capacity,
                    ["maxBonesPerSkeleton"] = SkeletonStore.MaxBonesPerSkeleton,
                    ["maxBoneInfluencesPerVertex"] = 4,
                },
                features = new[] { "linear-blend-skinning", "topological-reorder", "bind-pose-resolution" },
                editor = new
                {
                    panel = "rig-editor",
                    gizmos = new[] { "bone", "ik-chain", "weight-brush" },
                    nodeTypes = new[] { "skeleton", "bone", "ik-target" },
                    properties = new object[]
                    {
                        new { name = "boneLength", type = "float", min = 0.0, max = 4096.0, @default = 32.0 },
                        new { name = "ikSolver", type = "enum", options = new[] { "fabrik" }, @default = "fabrik" },
                        new { name = "easing", type = "curve", @default = "cubic-bezier" },
                    },
                },
            },
            sharedMemory = new
            {
                status = "available",
                limits = new Dictionary<string, double>
                {
                    ["headerBytes"] = MeshBufferHeader.HeaderBytes,
                    ["layoutVersion"] = SkinnedVertex2D.LayoutVersion,
                },
                features = new[] { "seqlock", "fnv1a-checksum", "file-backed-mmf" },
                vertexLayouts = new object[]
                {
                    new
                    {
                        name = nameof(SkinnedVertex2D),
                        layoutVersion = SkinnedVertex2D.LayoutVersion,
                        strideInBytes = SkinnedVertex2D.StrideInBytes,
                        fields = SkinnedVertex2D.LayoutDescription()
                            .Select(f => new { name = f.Name, offset = f.Offset, type = f.Type, semantic = f.Semantic })
                            .ToArray(),
                    },
                },
                editor = new
                {
                    panel = "mesh-inspector",
                    gizmos = new[] { "vertex-handles", "uv-overlay" },
                    nodeTypes = new[] { "mesh", "shared-buffer" },
                    properties = Array.Empty<object>(),
                },
            },
            camera = new
            {
                status = "planned",
                phase = 3,
                features = new[] { "second-order-spring-damper", "predictive-lookahead", "procedural-shake" },
                editor = new
                {
                    panel = "camera-rig",
                    gizmos = new[] { "follow-target", "deadzone-rect" },
                    nodeTypes = new[] { "camera", "shake-layer" },
                    properties = new object[]
                    {
                        new { name = "frequency", type = "float", min = 0.1, max = 10.0, @default = 2.0 },
                        new { name = "damping", type = "float", min = 0.0, max = 2.0, @default = 1.0 },
                        new { name = "anticipation", type = "float", min = 0.0, max = 1.0, @default = 0.25 },
                    },
                },
            },
            lighting = new
            {
                status = "planned",
                phase = 3,
                features = new[] { "deferred-2d", "mrt-gbuffer", "normal-maps", "color-lut" },
                editor = new
                {
                    panel = "lighting-pipeline",
                    gizmos = new[] { "light-radius", "spot-cone" },
                    nodeTypes = new[] { "point-light", "directional-light", "spot-light", "lut-grade" },
                    properties = new object[]
                    {
                        new { name = "intensity", type = "float", min = 0.0, max = 16.0, @default = 1.0 },
                        new { name = "color", type = "color", @default = "#ffffff" },
                    },
                },
            },
            assets = new
            {
                status = "planned",
                phase = 4,
                features = new[] { "tag-taxonomy", "ai-spritesheet-pipeline", "mgcb-xnb-compile" },
                editor = new
                {
                    panel = "asset-taxonomy",
                    gizmos = Array.Empty<string>(),
                    nodeTypes = new[] { "tag", "sprite-sheet", "generation-job" },
                    properties = Array.Empty<object>(),
                },
            },
        },
    };
}
