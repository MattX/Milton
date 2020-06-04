package io.terbium.milton

import com.google.cloud.datastore.Entity
import com.google.cloud.datastore.FullEntity
import com.google.cloud.datastore.IncompleteKey

object FirebaseExtensions {
    fun<K : IncompleteKey> FullEntity.Builder<K>.setNullableString(key: String, value: String?): FullEntity.Builder<K> {
        return apply {
            when (value) {
                null -> setNull(key)
                else -> set(key, value)
            }
        }
    }

    fun Entity.getNullableString(key: String): String? =
            if (isNull(key)) { null } else { getString(key) }
}