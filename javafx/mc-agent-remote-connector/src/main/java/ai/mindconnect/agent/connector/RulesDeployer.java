package ai.mindconnect.agent.connector;

import com.google.auth.oauth2.GoogleCredentials;

import java.io.FileInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * The one part of the Firebase setup that IS doable from Java: pushing the
 * Realtime Database security rules. Everything else — creating the project,
 * enabling Google sign-in, the database instance, minting the service-account
 * key — needs the console or the CLI (see relay/rtdb/setup-firebase.sh).
 *
 * <p>Uses the service account to mint a short-lived access token and PUTs the
 * rules to {@code <rtdbUrl>/.settings/rules.json}, the same endpoint the
 * Firebase CLI writes. Lets the launcher offer a one-click "deploy the
 * codeless rules for my email" without leaving the app.
 */
public final class RulesDeployer {

    private static final List<String> SCOPES = List.of(
            "https://www.googleapis.com/auth/firebase.database",
            "https://www.googleapis.com/auth/userinfo.email");

    private static final HttpClient HTTP = HttpClient.newHttpClient();

    /** Deploy the given rules JSON. Blocks; call off the UI thread. */
    public static void deploy(String rtdbUrl, String serviceAccountPath, String rulesJson) throws IOException {
        String token;
        try (FileInputStream key = new FileInputStream(serviceAccountPath)) {
            GoogleCredentials cred = GoogleCredentials.fromStream(key).createScoped(SCOPES);
            cred.refreshIfExpired();
            token = cred.getAccessToken().getTokenValue();
        }
        HttpRequest request = HttpRequest.newBuilder(
                        URI.create(rtdbUrl.replaceAll("/$", "") + "/.settings/rules.json"))
                .header("Authorization", "Bearer " + token)
                .header("content-type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(rulesJson, StandardCharsets.UTF_8))
                .build();
        try {
            HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() / 100 != 2) {
                throw new IOException("rules deploy answered " + response.statusCode() + ": " + response.body());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while deploying rules");
        }
    }

    /**
     * The codeless single-user rules: the whole {@code tunnels/} subtree gated
     * on a hardwired set of verified Google addresses. Matches
     * relay/rtdb/database.rules.json.
     */
    public static String codelessRules(List<String> allowedEmails) {
        StringBuilder cond = new StringBuilder("auth != null && auth.token.email_verified === true && (");
        for (int i = 0; i < allowedEmails.size(); i++) {
            if (i > 0) cond.append(" || ");
            cond.append("auth.token.email === '").append(allowedEmails.get(i).replace("'", "")).append("'");
        }
        cond.append(")");
        String c = cond.toString();
        return """
                {
                  "rules": {
                    ".read": false,
                    ".write": false,
                    "tunnels": {
                      "$serverId": {
                        ".read": "%s",
                        ".write": "%s"
                      }
                    }
                  }
                }
                """.formatted(c, c);
    }

    private RulesDeployer() { }
}
