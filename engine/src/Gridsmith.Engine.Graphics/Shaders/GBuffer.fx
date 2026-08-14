// Passo 1 do pipeline deferred 2D: gravação do G-Buffer via MRT.
//
//   RT0 (Albedo):  cor difusa do sprite/malha (RGBA8)
//   RT1 (Normal):  normal do normal map re-mapeada de [-1,1] para [0,1] (RGBA8)
//
// O Light Pass (DeferredLight.fx) consome os dois alvos para acumular a
// iluminação volumétrica; superfícies sem normal map usam a normal plana
// (0, 0, 1), codificada como (0.5, 0.5, 1.0).

#if OPENGL
    #define VS_SHADERMODEL vs_3_0
    #define PS_SHADERMODEL ps_3_0
#else
    #define VS_SHADERMODEL vs_4_0
    #define PS_SHADERMODEL ps_4_0
#endif

float4x4 ViewProjection;

Texture2D AlbedoTexture;
sampler2D AlbedoSampler = sampler_state { Texture = <AlbedoTexture>; };

Texture2D NormalTexture;
sampler2D NormalSampler = sampler_state { Texture = <NormalTexture>; };

struct VertexInput
{
    float2 Position : POSITION0;
    float2 Uv : TEXCOORD0;
};

struct VertexOutput
{
    float4 Position : SV_Position;
    float2 Uv : TEXCOORD0;
};

struct GBufferOutput
{
    float4 Albedo : COLOR0; // RT0
    float4 Normal : COLOR1; // RT1
};

VertexOutput GBufferVS(VertexInput input)
{
    VertexOutput output;
    output.Position = mul(float4(input.Position, 0, 1), ViewProjection);
    output.Uv = input.Uv;
    return output;
}

GBufferOutput GBufferPS(VertexOutput input)
{
    GBufferOutput output;
    output.Albedo = tex2D(AlbedoSampler, input.Uv);
    // normal map em espaço tangente 2D; alfa preserva máscara do sprite
    float3 normal = tex2D(NormalSampler, input.Uv).xyz;
    output.Normal = float4(normal, output.Albedo.a);
    return output;
}

technique GBuffer
{
    pass P0
    {
        VertexShader = compile VS_SHADERMODEL GBufferVS();
        PixelShader = compile PS_SHADERMODEL GBufferPS();
    }
}
