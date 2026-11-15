import java.net.URL;
public class TlsTest {
  public static void main(String[] args) throws Exception {
    var url = new URL(args[0]);
    var conn = (javax.net.ssl.HttpsURLConnection) url.openConnection();
    conn.setConnectTimeout(8000);
    conn.setReadTimeout(8000);
    System.out.println(args[0] + " -> " + conn.getResponseCode());
  }
}
