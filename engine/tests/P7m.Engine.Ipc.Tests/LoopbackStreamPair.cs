using System.Net;
using System.Net.Sockets;

namespace P7m.Engine.Ipc.Tests;

/// <summary>
/// Par de streams full-duplex conectados em loopback TCP — o análogo ao
/// <c>duplexPair()</c> usado nos testes do middleware.
/// </summary>
internal static class LoopbackStreamPair
{
    public static async Task<(Stream SideA, Stream SideB)> CreateAsync()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var clientTask = new TcpClient().ConnectAndReturnAsync("127.0.0.1", port);
            var serverSide = await listener.AcceptTcpClientAsync();
            var clientSide = await clientTask;
            serverSide.NoDelay = true;
            clientSide.NoDelay = true;
            return (serverSide.GetStream(), clientSide.GetStream());
        }
        finally
        {
            listener.Stop();
        }
    }

    private static async Task<TcpClient> ConnectAndReturnAsync(
        this TcpClient client, string host, int port)
    {
        await client.ConnectAsync(host, port);
        return client;
    }
}
