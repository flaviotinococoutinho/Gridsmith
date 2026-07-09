// Passo 3 do pipeline deferred 2D: composição final + correção cromática.
//
//   final = albedo × (ambiente + acumulação de luzes)
//   grade = LUT(luminância(final))            — gradient map 1D
//   out   = lerp(final, grade, LutStrength)   — paletas dinâmicas (dia/noite)
//
// CONTRATO ESPELHADO: a amostragem da LUT e a luminância Rec.709 são
// idênticas à referência de CPU P7m.Engine.Core/Lighting/ColorLut.cs.

#if OPENGL
    #define VS_SHADERMODEL vs_3_0
    #define PS_SHADERMODEL ps_3_0
#else
    #define VS_SHADERMODEL vs_4_0
    #define PS_SHADERMODEL ps_4_0
#endif

Texture2D AlbedoBuffer;
sampler2D AlbedoSampler = sampler_state { Texture = <AlbedoBuffer>; };

Texture2D LightBuffer;
sampler2D LightSampler = sampler_state { Texture = <LightBuffer>; };

Texture2D LutTexture; // 1D: N×1 pixels
sampler2D LutSampler = sampler_state
{
    Texture = <LutTexture>;
    AddressU = Clamp;
    AddressV = Clamp;
};

float3 AmbientColor;
float LutStrength;

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

VertexOutput CompositeVS(VertexInput input)
{
    VertexOutput output;
    output.Position = float4(input.Position, 0, 1); // quad em tela cheia (NDC)
    output.Uv = input.Uv;
    return output;
}

float4 CompositePS(VertexOutput input) : COLOR0
{
    float4 albedo = tex2D(AlbedoSampler, input.Uv);
    float3 light = tex2D(LightSampler, input.Uv).rgb;
    float3 final = albedo.rgb * (AmbientColor + light);

    // luminância Rec.709 — mesma constante de ColorLut.Luminance
    float luminance = dot(final, float3(0.2126, 0.7152, 0.0722));
    float3 graded = tex2D(LutSampler, float2(luminance, 0.5)).rgb;

    return float4(lerp(final, graded, LutStrength), albedo.a);
}

technique Composite
{
    pass P0
    {
        VertexShader = compile VS_SHADERMODEL CompositeVS();
        PixelShader = compile PS_SHADERMODEL CompositePS();
    }
}
