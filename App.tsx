import React, { useEffect } from "react";
import AppNavigator from "./src/navigation/AppNavigator";
import { initDatabase } from "./src/database/schema";
import { GestureHandlerRootView } from "react-native-gesture-handler";

export default function App() {
	useEffect(() => {
		const setup = async () => {
			await initDatabase();
		};

		setup();
	}, []);

	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<AppNavigator />
		</GestureHandlerRootView>
	);
}
