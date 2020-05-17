package io.terbium.milton

import com.google.api.client.googleapis.auth.oauth2.GoogleIdToken
import com.google.api.client.googleapis.auth.oauth2.GoogleIdTokenVerifier
import com.google.api.client.googleapis.javanet.GoogleNetHttpTransport
import com.google.api.client.json.gson.GsonFactory
import javax.inject.Inject

class GoogleAuthenticator @Inject constructor(@GoogleAuthClientId private val clientId: String) {
    private val transport = GoogleNetHttpTransport.newTrustedTransport()
    private val jsonFactory = GsonFactory.getDefaultInstance()

    fun verify(idTokenString: String): Boolean {
        val verifier = GoogleIdTokenVerifier.Builder(transport, jsonFactory) // Specify the CLIENT_ID of the app that accesses the backend:
                .setAudience(listOf(clientId)) // Or, if multiple clients access the backend:
                .build()

        val idToken: GoogleIdToken? = verifier.verify(idTokenString)
        return idToken != null
    }
}
