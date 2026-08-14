namespace Gridsmith.Engine.Ipc.Protocol;

/// <summary>
/// Constantes do plano de controle JSON-RPC 2.0.
/// Espelha <c>contracts/schemas/</c> — fonte única de verdade.
/// </summary>
public static class JsonRpcProtocol
{
    public const string JsonRpcVersion = "2.0";

    /// <summary>Versão negociada no handshake. MAJOR incompatível recusa a conexão.</summary>
    public const string ProtocolVersion = "1.0";
}

/// <summary>Códigos de erro padrão e de domínio (ver contracts/schemas/error-codes.md).</summary>
public static class RpcErrorCode
{
    public const int ParseError = -32700;
    public const int InvalidRequest = -32600;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32603;

    public const int EngineNotReady = -32000;
    public const int ProtocolMismatch = -32001;
    public const int UnknownSkeleton = -32002;
    public const int UnknownMesh = -32003;
    public const int SharedMemoryUnavailable = -32004;
    public const int InvalidBinaryLayout = -32005;
    public const int DuplicateId = -32006;
}

/// <summary>Erro de RPC lançável por handlers; convertido em resposta de erro tipada.</summary>
public sealed class JsonRpcException(int code, string message) : Exception(message)
{
    public int Code { get; } = code;
}
